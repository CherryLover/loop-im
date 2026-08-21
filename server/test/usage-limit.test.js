// 服务端用量限流：发消息 / @AI / 上传 / 群写操作，按用户维度数「成功次数」。
// 和登录那套「只数失败、成功清零」是两套语义，见 src/usage-limit.js 开头。
import { startServer, waitFor } from './helpers.js';
import { direct, group, member } from './fixtures.js';
import { PNG } from './samples.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, adminToken, limit, chen, chenToken, zhou, room;

before(async () => {
  api = await startServer();
  adminToken = await api.loginAdmin();
  limit = await import('../src/usage-limit.js');
  chen = await member('陈子航', { dept: '后端' });
  zhou = await member('周明', { dept: '前端' });
  chenToken = await api.login(chen.email);
  room = await group(api, adminToken, '限流 · 发版协作', [chen.id, zhou.id]);
});
after(async () => { await api.close(); });

beforeEach(() => limit.resetUsageLimits());

const send = (body, token = chenToken) => api.post(`/api/conversations/${room.id}/messages`, { body }, token);

// ---- 默认值 --------------------------------------------------------------

describe('限流默认阈值', () => {
  // 断言的是 DEFAULT_LIMITS（真正会发到生产的那份），不是 usageLimits ——
  // 后者在测试进程里被 helpers.js 整体抬高了，拿它断言等于什么都没测。
  const D = () => limit.DEFAULT_LIMITS;

  it('默认值按「正常人聊天撞不上」定：一分钟 60 条消息、五分钟 10 次 @AI', () => {
    assert.equal(D().message.max, 60);
    assert.equal(D().message.windowMs, 60_000);
    assert.equal(D().ai.max, 10);
    assert.equal(D().ai.windowMs, 5 * 60_000);
    assert.equal(D().upload.max, 20);
    assert.equal(D().write.max, 30);
  });

  it('@AI 那一档必须严于普通发消息 —— 它每次都真花钱', () => {
    const rate = (d) => d.max / d.windowMs;
    assert.ok(rate(D().ai) < rate(D().message), '@AI 的允许速率必须严于普通发消息');
    assert.ok(rate(D().ai) < rate(D().upload));
  });

  it('环境变量能覆盖，非法值退回默认', async () => {
    // num() 的口径：正数才认，其余（负数、0、非数字、空）一律退回默认值。
    const original = process.env.RATE_MESSAGE_MAX;
    try {
      for (const bad of ['0', '-5', 'abc', '']) {
        process.env.RATE_MESSAGE_MAX = bad;
        const fresh = await import(`../src/usage-limit.js?bad=${encodeURIComponent(bad)}`);
        assert.equal(fresh.usageLimits.message.max, 60, `非法值 ${JSON.stringify(bad)} 应当退回默认`);
      }
      process.env.RATE_MESSAGE_MAX = '7';
      const tuned = await import('../src/usage-limit.js?tuned=1');
      assert.equal(tuned.usageLimits.message.max, 7);
    } finally {
      if (original === undefined) delete process.env.RATE_MESSAGE_MAX;
      else process.env.RATE_MESSAGE_MAX = original;
    }
  });
});

// ---- 发消息 --------------------------------------------------------------

describe('发消息限流', () => {
  it('正常节奏发消息不会被限：把阈值压回生产默认值，连发 30 条也一条不挡', async () => {
    // 用真正的生产默认值（60 条 / 分钟）跑，而不是测试进程里那份被抬高的值。
    const restore = limit.configureUsageLimit('message', limit.DEFAULT_LIMITS.message);
    try {
      limit.resetUsageLimits();
      // 30 条已经是人手打字最猛时（一串「好」「收到」）一分钟的量再翻一倍。
      for (let i = 0; i < 30; i += 1) {
        const res = await send(`正常节奏的第 ${i + 1} 条`);
        assert.equal(res.status, 201, `第 ${i + 1} 条不该被限流`);
      }
    } finally {
      restore();
    }
  });

  it('超过阈值返回 429，retryAfterMs 合理且带 Retry-After 头', async () => {
    const restore = limit.configureUsageLimit('message', { max: 3, windowMs: 60_000 });
    try {
      for (let i = 0; i < 3; i += 1) assert.equal((await send(`第 ${i + 1} 条`)).status, 201);

      const res = await api.call('POST', `/api/conversations/${room.id}/messages`,
        { token: chenToken, body: { body: '第 4 条' } });
      assert.equal(res.status, 429);
      assert.equal(res.body.scope, 'message');
      assert.match(res.body.error, /太快/);
      // 相对毫秒：必须是正数，且不超过窗口本身。
      assert.ok(res.body.retryAfterMs > 0, 'retryAfterMs 应当为正');
      assert.ok(res.body.retryAfterMs <= 60_000, 'retryAfterMs 不该超过窗口长度');
      // 服务端当前时间戳一并给出，供前端排查时差（显示仍然用 retryAfterMs 本地换算）。
      assert.ok(Math.abs(res.body.serverNow - Date.now()) < 10_000);
      assert.equal(res.body.limit, 3);
      assert.equal(res.body.windowMs, 60_000);
    } finally {
      restore();
    }
  });

  it('被限流时确实没往库里写：消息条数一条都没多', async () => {
    const restore = limit.configureUsageLimit('message', { max: 2, windowMs: 60_000 });
    try {
      const before = (await api.get(`/api/conversations/${room.id}/messages?limit=200`, chenToken)).body.messages.length;
      for (let i = 0; i < 2; i += 1) await send(`能发出去的第 ${i + 1} 条`);
      for (let i = 0; i < 5; i += 1) {
        assert.equal((await api.call('POST', `/api/conversations/${room.id}/messages`,
          { token: chenToken, body: { body: '被挡下的' } })).status, 429);
      }
      const after = (await api.get(`/api/conversations/${room.id}/messages?limit=200`, chenToken)).body.messages.length;
      assert.equal(after - before, 2, '被限流的请求不该落库');
    } finally {
      restore();
    }
  });

  it('窗口过去之后自动恢复，不会把人永久锁死', () => {
    const restore = limit.configureUsageLimit('message', { max: 3, windowMs: 60_000 });
    try {
      const t0 = 1_700_000_000_000;
      for (let i = 0; i < 3; i += 1) limit.consumeQuota('message', 'u_lin', t0 + i);

      assert.equal(limit.quotaState('message', 'u_lin', t0 + 1_000).allowed, false);
      assert.equal(limit.quotaState('message', 'u_lin', t0 + 59_000).allowed, false);
      assert.equal(limit.quotaState('message', 'u_lin', t0 + 60_001).allowed, true, '窗口过后应当自动放行');
    } finally {
      restore();
    }
  });

  it('等得越久 retryAfterMs 越小 —— 是相对量而不是固定值', () => {
    const restore = limit.configureUsageLimit('message', { max: 2, windowMs: 60_000 });
    try {
      const t0 = 1_700_000_000_000;
      for (let i = 0; i < 2; i += 1) limit.consumeQuota('message', 'u_lin', t0 + i);
      const early = limit.quotaState('message', 'u_lin', t0 + 1_000).retryAfterMs;
      const later = limit.quotaState('message', 'u_lin', t0 + 30_000).retryAfterMs;
      assert.ok(later < early, `等了 30 秒之后应当只剩更短的等待（${early} -> ${later}）`);
      assert.ok(later > 0);
    } finally {
      restore();
    }
  });

  it('按用户分账：一个人被限流，另一个人照发不误', async () => {
    const restore = limit.configureUsageLimit('message', { max: 2, windowMs: 60_000 });
    try {
      const zhouToken = await api.login(zhou.email);
      for (let i = 0; i < 2; i += 1) await send(`陈子航第 ${i + 1} 条`);
      assert.equal((await api.call('POST', `/api/conversations/${room.id}/messages`,
        { token: chenToken, body: { body: '再来一条' } })).status, 429);
      // 同一个会话、同一个来源 IP，但换个人就该照常发得出去（维度是用户不是 IP）。
      assert.equal((await send('周明来说一句', zhouToken)).status, 201);
    } finally {
      restore();
    }
  });

  it('空消息这类 400 不吃额度：额度是给「成功发出去的」记的', async () => {
    const restore = limit.configureUsageLimit('message', { max: 2, windowMs: 60_000 });
    try {
      for (let i = 0; i < 10; i += 1) {
        assert.equal((await api.call('POST', `/api/conversations/${room.id}/messages`,
          { token: chenToken, body: { body: '   ' } })).status, 400);
      }
      // 十次 400 之后额度应当分文未动，还能正常发满两条。
      for (let i = 0; i < 2; i += 1) assert.equal((await send(`还能发第 ${i + 1} 条`)).status, 201);
    } finally {
      restore();
    }
  });
});

// ---- @AI 单独一档 --------------------------------------------------------

describe('@AI 限流', () => {
  it('@Aria 同时吃 message 和 ai 两档，普通消息只吃 message 档', async () => {
    limit.resetUsageLimits();
    await send('一条谁也没 @ 的普通消息');
    assert.equal(limit.quotaState('message', chen.id).used, 1);
    assert.equal(limit.quotaState('ai', chen.id).used, 0, '普通消息不该占 @AI 的额度');

    await send('@Aria 帮忙看一下发版风险');
    assert.equal(limit.quotaState('message', chen.id).used, 2);
    assert.equal(limit.quotaState('ai', chen.id).used, 1, '@Aria 才占 @AI 的额度');
  });

  it('@AI 额度用完时单独返回 429（scope 为 ai），普通消息仍然发得出去', async () => {
    const restore = limit.configureUsageLimit('ai', { max: 2, windowMs: 60_000 });
    try {
      for (let i = 0; i < 2; i += 1) assert.equal((await send(`@Aria 第 ${i + 1} 问`)).status, 201);

      const blocked = await api.call('POST', `/api/conversations/${room.id}/messages`,
        { token: chenToken, body: { body: '@Aria 再问一次' } });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.scope, 'ai', '应当是 @AI 那一档挡下的');
      assert.ok(blocked.body.retryAfterMs > 0);

      // 只是不能再叫 Aria 了，人和人之间照常聊。
      assert.equal((await send('那我们先自己对一下')).status, 201);
    } finally {
      restore();
    }
  });

  it('群里没有 Aria 时 @全员 不占 @AI 额度（那条路本来就不会调模型）', async () => {
    const { run } = await import('../src/db.js');
    const { AI_ID } = await import('../src/ai.js');
    const { saveSettings } = await import('../src/ai.js');
    const solo = await group(api, adminToken, '限流 · 无 Aria 群', [chen.id]);
    run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', solo.id, AI_ID);
    const before = saveSettings({ replyAtAll: 1 });
    try {
      limit.resetUsageLimits();
      const res = await api.post(`/api/conversations/${solo.id}/messages`, { body: '@全员 站会推迟' }, chenToken);
      assert.equal(res.status, 201);
      assert.equal(limit.quotaState('ai', chen.id).used, 0, '不会调模型的消息不该占 @AI 额度');
    } finally {
      saveSettings({ replyAtAll: before.reply_at_all ? 1 : 0 });
    }
  });
});

// ---- AI 自己发的消息不受限 -----------------------------------------------

describe('AI 自己发的消息不受限流', () => {
  it('AI 的用户 id 在任何档位上都豁免', () => {
    const restore = limit.configureUsageLimit('message', { max: 1, windowMs: 60_000 });
    try {
      for (let i = 0; i < 50; i += 1) limit.consumeQuota('message', 'ai');
      assert.equal(limit.quotaState('message', 'ai').allowed, true, 'AI 不该被自己的额度挡住');
      assert.equal(limit.quotaState('ai', 'ai').allowed, true);
      // 同一时刻普通用户是会被挡住的，说明豁免确实是针对 AI 而不是限流没生效。
      limit.consumeQuota('message', 'u_lin');
      assert.equal(limit.quotaState('message', 'u_lin').allowed, false);
    } finally {
      restore();
    }
  });

  it('用户额度只按用户自己发的条数算，Aria 的回复不算进去', async () => {
    // 阈值设成 2。AI 私聊里每条用户消息都会带来一条 Aria 的回复，
    // 如果限流数的是「会话里新增了几条消息」，第 2 条用户消息就会被挡；
    // 数的是「这个用户发了几条」才对，所以两条都该成功。
    const restore = limit.configureUsageLimit('message', { max: 2, windowMs: 60_000 });
    try {
      const dm = await direct(api, chenToken, 'ai');
      limit.resetUsageLimits();

      assert.equal((await api.post(`/api/conversations/${dm.id}/messages`, { body: '第一问' }, chenToken)).status, 201);
      const afterFirst = await waitFor(async () => {
        const rows = (await api.get(`/api/conversations/${dm.id}/messages`, chenToken)).body.messages;
        return rows.some((m) => m.isAI) ? rows : null;
      });
      assert.ok(afterFirst.length >= 2, 'Aria 应当已经回过一条');

      // Aria 刚插了一条消息，用户自己的额度必须原封不动地只用掉 1。
      assert.equal(limit.quotaState('message', chen.id).used, 1, 'Aria 的回复不该算进用户额度');
      assert.equal(
        (await api.post(`/api/conversations/${dm.id}/messages`, { body: '第二问' }, chenToken)).status,
        201,
        '用户自己只发了 2 条，不该被挡',
      );
    } finally {
      restore();
    }
  });
});

// ---- 上传与群写操作 ------------------------------------------------------

describe('上传与写接口限流', () => {
  const uploadOnce = async (path = '/api/uploads') => {
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'dot.png');
    return api.call('POST', path, { token: chenToken, form });
  };

  it('上传超过阈值返回 429，并带 retryAfterMs', async () => {
    const restore = limit.configureUsageLimit('upload', { max: 2, windowMs: 60_000 });
    try {
      for (let i = 0; i < 2; i += 1) assert.equal((await uploadOnce()).status, 201);
      const blocked = await uploadOnce();
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.scope, 'upload');
      assert.ok(blocked.body.retryAfterMs > 0);
    } finally {
      restore();
    }
  });

  it('头像和聊天附件共用同一档上传额度', async () => {
    const restore = limit.configureUsageLimit('upload', { max: 1, windowMs: 60_000 });
    try {
      assert.equal((await uploadOnce()).status, 201);
      assert.equal((await uploadOnce('/api/auth/me/avatar')).status, 429);
    } finally {
      restore();
    }
  });

  it('建群超过阈值返回 429', async () => {
    const restore = limit.configureUsageLimit('write', { max: 1, windowMs: 60_000 });
    try {
      limit.resetUsageLimits();
      assert.equal((await api.post('/api/conversations/group',
        { title: '写限流 A', memberIds: [chen.id] }, adminToken)).status, 201);
      const blocked = await api.call('POST', '/api/conversations/group',
        { token: adminToken, body: { title: '写限流 B', memberIds: [chen.id] } });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.scope, 'write');
    } finally {
      restore();
    }
  });
});

// ---- 日志 ----------------------------------------------------------------

describe('限流日志', () => {
  /** 临时打开测试环境下的日志，把 stderr 收下来（logWarn 走 stderr）。 */
  const captureWarn = async (fn) => {
    const lines = [];
    const original = console.error;
    const wasSilent = process.env.LOG_IN_TEST;
    process.env.LOG_IN_TEST = '1';
    console.error = (line) => lines.push(String(line));
    try {
      await fn();
    } finally {
      console.error = original;
      if (wasSilent === undefined) delete process.env.LOG_IN_TEST;
      else process.env.LOG_IN_TEST = wasSilent;
    }
    return lines.map((l) => JSON.parse(l)).filter((e) => e.event === 'rate-limited');
  };

  it('记下谁、哪个接口、还要等多久，但正文一个字都不进日志', async () => {
    const restore = limit.configureUsageLimit('message', { max: 1, windowMs: 60_000 });
    const secret = '这段正文绝对不允许出现在日志里';
    try {
      limit.resetUsageLimits();
      await send('第一条');
      const events = await captureWarn(async () => {
        await api.call('POST', `/api/conversations/${room.id}/messages`,
          { token: chenToken, body: { body: secret } });
      });

      assert.equal(events.length, 1);
      assert.equal(events[0].action, 'message');
      assert.equal(events[0].userId, chen.id);
      assert.match(events[0].route, /\/messages$/);
      assert.ok(events[0].retryAfterMs > 0);
      assert.ok(!JSON.stringify(events[0]).includes(secret), '消息正文绝不能出现在日志里');
    } finally {
      restore();
    }
  });

  it('一个窗口只记一条：刷限流的脚本不会把日志刷爆', async () => {
    const restore = limit.configureUsageLimit('message', { max: 1, windowMs: 60_000 });
    try {
      limit.resetUsageLimits();
      await send('第一条');
      const events = await captureWarn(async () => {
        for (let i = 0; i < 20; i += 1) {
          await api.call('POST', `/api/conversations/${room.id}/messages`,
            { token: chenToken, body: { body: '再来' } });
        }
      });
      assert.equal(events.length, 1, `撞了 20 次也只该记 1 条，实际 ${events.length} 条`);
    } finally {
      restore();
    }
  });
});

// ---- 和登录限流互不干扰 --------------------------------------------------

describe('与登录限流互不干扰', () => {
  it('两套计数各存各的：清空用量限流不会影响登录的失败计数', async () => {
    const { resetRateLimit, recordFailure, retryAfterMs, rateLimitConfig } = await import('../src/rate-limit.js');
    resetRateLimit();
    const keys = ['email:someone@test.local'];
    for (let i = 0; i < rateLimitConfig.maxFailures; i += 1) recordFailure(keys, Date.now());

    limit.resetUsageLimits();                       // 清的是用量那张表
    assert.ok(retryAfterMs(keys) > 0, '登录的失败计数不该被用量限流清掉');
    resetRateLimit();
  });

  it('发消息成功不会清掉自己的计数（和登录「成功清零」的语义正好相反）', () => {
    const restore = limit.configureUsageLimit('message', { max: 5, windowMs: 60_000 });
    try {
      limit.resetUsageLimits();
      for (let i = 0; i < 3; i += 1) limit.consumeQuota('message', 'u_lin');
      assert.equal(limit.quotaState('message', 'u_lin').used, 3, '成功了也要照样记账');
    } finally {
      restore();
    }
  });
});
