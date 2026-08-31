// 关键路径的埋点：既要证明「该记的记下来了」，也要证明「不该记的一个字都没进去」。
//
// 后一半是这个文件存在的主要理由。log.js 的 redact() 按字段名兜底，但它拦不住没列进去的
// 键——传 { note: 消息正文 } 一样会原样打出来。逐个 review 埋点靠不住，人总会漏，
// 而且下一个往这些路径上加日志的人不会来读 review 记录。所以这里换一种验法：
// 把一串只可能来自消息正文/密码的特征字串喂进系统，跑一遍真实请求，
// 把这期间产生的**所有**日志行抓下来，断言那串字符一次都没出现过。
//
// 这样加新埋点的人不用懂规则也会被挡住：只要他把正文塞进日志，这里就红。
import { startServer, ADMIN, ADMIN_PASSWORD, PASSWORD } from './helpers.js';
import { group, member, members } from './fixtures.js';
import { resetRateLimit } from '../src/rate-limit.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, admin, adminId;

before(async () => {
  api = await startServer();
  admin = await api.loginAdmin();
  adminId = (await api.get('/api/auth/me', admin)).body.user.id;
});
after(async () => { await api.close(); });

// ---- 收网工具 -----------------------------------------------------------

/**
 * 跑一段真实请求，把这期间打出来的每一行日志都收下来。
 *
 * 测试服务器跟用例在同一个进程里（见 helpers.js 的 startServer），所以服务端的
 * console.log / console.error 就是这里换掉的这两个 —— 服务端埋点原样落进 lines。
 *
 * 两个细节不能省：
 * - LOG_IN_TEST=1：log.js 在测试环境默认闭嘴，不打开就什么也抓不到，
 *   「没有泄漏」会变成「没有日志」，用例绿得毫无意义（下面专门断言了确实抓到了行）。
 * - settleMs：发消息接口是先响应、后台再做推送分发（见 conversations.js 的
 *   pushForMessage，「发射后不管」）。响应一回来就收网的话，漏掉的恰恰是最该检查的那几行。
 */
async function capture(fn, { settleMs = 250 } = {}) {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  const prev = process.env.LOG_IN_TEST;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  console.error = (...args) => lines.push(args.map(String).join(' '));
  process.env.LOG_IN_TEST = '1';
  let result;
  try {
    result = await fn();
    await new Promise((r) => setTimeout(r, settleMs));
  } finally {
    console.log = origLog;
    console.error = origErr;
    if (prev === undefined) delete process.env.LOG_IN_TEST;
    else process.env.LOG_IN_TEST = prev;
  }
  const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { result, lines, rows, events: rows.map((r) => r.event) };
}

const rowsFor = (cap, event) => cap.rows.filter((r) => r.event === event);
const oneRow = (cap, event) => {
  const found = rowsFor(cap, event);
  assert.equal(found.length, 1, `期望恰好一条 ${event}，实际 ${found.length} 条：${cap.events.join(', ')}`);
  return found[0];
};

// ---- 红线：正文 / 密码不许进日志 ----------------------------------------

// 只可能来自消息正文的特征字串。ASCII 那一段保证 JSON 转义不会把它藏起来，
// 中文那一段保证非 ASCII 路径也照查。
const CANARY = 'ZQX-LEAK-CANARY-7f3a9';
const CANARY_CN = '这条正文绝不许出现在日志里';
const SECRET_PASSWORD = 'ZQX-PASSWORD-CANARY-4b1e2';

/** 把整批日志行连起来查：任何一行、任何一个字段里出现特征字串都算泄漏。 */
function assertNoLeak(cap, needles = [CANARY, CANARY_CN]) {
  assert.ok(cap.lines.length > 0, '一行日志都没抓到 —— 这轮用例什么也没验证到，先查 LOG_IN_TEST 和埋点是否还在');
  const blob = cap.lines.join('\n');
  for (const needle of needles) {
    if (!blob.includes(needle)) continue;
    const leaked = cap.lines.filter((l) => l.includes(needle));
    assert.fail(`「${needle}」漏进了日志，共 ${leaked.length} 行：\n${leaked.join('\n')}`);
  }
}

describe('日志红线 · 消息正文不许泄漏', () => {
  it('发消息、引用回复、表情回应：跑完整条链路，正文一次都没出现', async () => {
    const [zhou, xin] = await members('周正文', '辛新人');
    const g = await group(api, admin, '埋点冒烟群', [zhou.id]);
    const token = await api.login(zhou.email);

    const cap = await capture(async () => {
      // 1. 普通消息：写库 + SSE 广播 + 会话预览
      const first = await api.post(`/api/conversations/${g.id}/messages`, { body: `${CANARY} ${CANARY_CN}` }, token);
      assert.equal(first.status, 201);
      const messageId = first.body.message.id;

      // 2. 引用回复：quoteOf 会把被引用消息的正文截断成摘要，最容易顺手记进日志的地方
      await api.post(`/api/conversations/${g.id}/messages`, { body: '收到', replyTo: messageId }, token);

      // 3. 表情回应 + 4. 拉取消息列表 + 5. 全文搜索
      await api.post(`/api/conversations/${g.id}/messages/${messageId}/reactions`, { emoji: '👍' }, token);
      await api.get(`/api/conversations/${g.id}/messages`, token);
      await api.get(`/api/messages/search?q=${encodeURIComponent(CANARY)}`, token);
      // 6. 会话列表：lastMessage.preview 就是正文的截断
      await api.get('/api/conversations', token);
      // 7. 加人：这一步确实会打日志，顺带保证「本轮抓到的行」不是零
      await api.post(`/api/conversations/${g.id}/members`, { userIds: [xin.id] }, admin);
    });

    assert.ok(cap.events.includes('group.members_added'));
    assertNoLeak(cap);
  });

  it('群名和昵称这类用户自己写的内容也不往日志里抄', async () => {
    const [qian] = await members('钱群名');
    const cap = await capture(async () => {
      await api.post('/api/conversations/group', { title: CANARY_CN, memberIds: [qian.id] }, admin);
      await api.patch('/api/auth/me', { name: CANARY }, admin);
    });
    await api.patch('/api/auth/me', { name: '测试管理员' }, admin);   // 名字改回去，别影响后面的用例

    assertNoLeak(cap);
  });

  it('密码不进日志：登录成功、登录失败、自己改密码、管理员重置，四条路径都查', async () => {
    const target = await member('郑密码', { password: SECRET_PASSWORD });

    const cap = await capture(async () => {
      // 登录成功
      const ok = await api.post('/api/auth/login', { email: target.email, password: SECRET_PASSWORD });
      assert.equal(ok.status, 200);
      // 登录失败（密码错）—— 错的那个密码同样不许记
      await api.post('/api/auth/login', { email: target.email, password: `${SECRET_PASSWORD}-错的` });
      // 自己改密码：新旧两个明文都经过了这条路径
      await api.post('/api/auth/me/password', { current: SECRET_PASSWORD, next: `${SECRET_PASSWORD}-新的` }, ok.body.token);
      // 管理员重置：服务端当场生成一串明文密码，它是那个账号此刻的全部凭据
      const reset = await api.post(`/api/users/${target.id}/reset-password`, {}, admin);
      assert.equal(reset.status, 200);
      // 这串明文只在响应里出现一次，日志里绝不许有第二份（下面连它一起查）
      return reset.body.password;
    });
    resetRateLimit();

    // 除了两个特征密码，把服务端刚生成的那串明文也一起查
    assertNoLeak(cap, [SECRET_PASSWORD, cap.result]);
  });

  it('JWT 不进日志：凭据被拒的那几条路径最容易顺手把 token 记下来', async () => {
    const [feng] = await members('冯凭据');
    const token = await api.login(feng.email);

    const cap = await capture(async () => {
      // 停用他，手上这张 token 立刻失效，再拿它请求就会走 auth.credential.rejected
      await api.post(`/api/users/${feng.id}/disable`, {}, admin);
      await api.get('/api/conversations', token);
      await api.get('/api/auth/me', 'eyJhbGciOiJIUzI1NiJ9.ZmFrZS1wYXlsb2Fk.not-a-real-signature');
    });

    // token 本身、以及它的任何一段，都不许出现
    assertNoLeak(cap, [token, token.slice(0, 20), token.split('.')[2]]);
    // 但事件本身要记下来，否则「没泄漏」只是因为压根没埋点
    assert.ok(cap.events.includes('auth.credential.rejected'), `凭据被拒没记日志：${cap.events.join(', ')}`);
  });

});

// ---- 关键事件确实被打出来了 ---------------------------------------------

describe('埋点 · 鉴权', () => {
  it('登录成功记下是谁、从哪来', async () => {
    const [sun] = await members('孙登录');
    const cap = await capture(() => api.post('/api/auth/login', { email: sun.email, password: PASSWORD }));

    const row = oneRow(cap, 'auth.login.ok');
    assert.equal(row.userId, sun.id);
    assert.equal(row.level, 'info');
    assert.ok(row.ip, '没记来源 IP，撞库时查不出是谁在撞');
    assert.ok(row.reqId, '没有 reqId，这条日志跟同一次请求的其他行串不起来');
  });

  it('登录失败按原因分类：账号不存在 / 密码不对 / 账号已停用', async () => {
    const [li] = await members('李失败');

    const cap = await capture(async () => {
      await api.post('/api/auth/login', { email: 'nobody@test.local', password: PASSWORD });
      await api.post('/api/auth/login', { email: li.email, password: '不对的密码' });
      await api.post(`/api/users/${li.id}/disable`, {}, admin);
      await api.post('/api/auth/login', { email: li.email, password: PASSWORD });
    });
    resetRateLimit();

    const reasons = rowsFor(cap, 'auth.login.failed').map((r) => r.reason);
    assert.deepEqual(reasons, ['no_such_account', 'bad_password', 'account_disabled']);
    // 账号不存在时没有 userId 可记，其余两条必须指名道姓
    assert.equal(rowsFor(cap, 'auth.login.failed')[0].userId, null);
    assert.equal(rowsFor(cap, 'auth.login.failed')[1].userId, li.id);
    // 失败一律走 warn（stderr），跟正常事件分得开
    for (const row of rowsFor(cap, 'auth.login.failed')) assert.equal(row.level, 'warn');
  });

  it('登录失败不把邮箱抄进日志 —— 攒久了就是一份账号清单', async () => {
    const cap = await capture(() =>
      api.post('/api/auth/login', { email: 'zhaoliu@example.com', password: '不对的密码' }));
    resetRateLimit();

    assertNoLeak(cap, ['zhaoliu@example.com', 'zhaoliu']);
    assert.equal(rowsFor(cap, 'auth.login.failed').length, 1, '邮箱不记，但失败这件事要记');
  });

  it('限流被触发时留痕，否则只能看到一堆失败却不知道有没有挡住', async () => {
    const cap = await capture(async () => {
      // 不存在的邮箱失败最快（根本不走 bcrypt），用它把窗口撑满
      for (let i = 0; i < 40; i += 1) {
        const res = await api.post('/api/auth/login', { email: 'flood@test.local', password: 'x' });
        if (res.status === 429) return;
      }
      assert.fail('打了 40 次都没被限流，限流是不是没生效？');
    });
    resetRateLimit();

    const row = rowsFor(cap, 'auth.login.throttled')[0];
    assert.ok(row, `限流触发了却没记日志：${[...new Set(cap.events)].join(', ')}`);
    assert.equal(row.level, 'warn');
    assert.ok(row.waitMs > 0, '没记还要等多久');
  });

  it('退出登录留痕', async () => {
    const [zhu] = await members('朱退出');
    const token = await api.login(zhu.email);
    const cap = await capture(() => api.post('/api/auth/logout', {}, token));

    const row = oneRow(cap, 'auth.logout');
    assert.equal(row.userId, zhu.id);
  });

  it('凭据失效按原因分类：密码被改过 / 会话已退出 / 账号被停用', async () => {
    const [hu] = await members('胡失效');
    const stale = await api.login(hu.email);
    const live = await api.login(hu.email);

    const cap = await capture(async () => {
      // 本人改密码 → auth_version +1 → 另一台设备上那张旧 token 作废
      await api.post('/api/auth/me/password', { current: PASSWORD, next: 'another-password-8' }, live);
      await api.get('/api/conversations', stale);
    });

    const row = oneRow(cap, 'auth.credential.rejected');
    assert.equal(row.reason, 'password_changed');
    assert.equal(row.userId, hu.id);
    assert.ok(row.path, '没记是哪个接口被拒的');
    // 本人改密码这件事本身也要留痕
    assert.equal(oneRow(cap, 'auth.password.changed').by, 'self');
  });

  it('没带 token 的匿名请求不记 —— 前端没登录时每次刷新都来一发，记了只会淹掉真东西', async () => {
    const cap = await capture(() => api.get('/api/conversations'));
    assert.deepEqual(rowsFor(cap, 'auth.credential.rejected'), []);
  });
});

describe('埋点 · 管理动作（谁对谁做了什么）', () => {
  it('开通账号、重置密码、停用、恢复：四条都记下了操作者和被操作者', async () => {
    const cap = await capture(async () => {
      const created = await api.post('/api/users', { name: '新来的', email: 'newbie@test.local', dept: '研发' }, admin);
      const id = created.body.user.id;
      await api.post(`/api/users/${id}/reset-password`, {}, admin);
      await api.post(`/api/users/${id}/disable`, {}, admin);
      await api.post(`/api/users/${id}/enable`, {}, admin);
      return id;
    });

    const expected = ['admin.user.created', 'admin.user.password_reset', 'admin.user.disabled', 'admin.user.enabled'];
    for (const event of expected) {
      const row = oneRow(cap, event);
      assert.equal(row.actorId, adminId, `${event} 没记是谁干的`);
      assert.equal(row.targetId, cap.result, `${event} 没记对谁干的`);
      assert.ok(!Number.isNaN(Date.parse(row.ts)), `${event} 的时间戳不合法`);
    }
  });

  it('被挡下来的管理动作不记 —— 没发生的事不该在审计里留一行', async () => {
    const [ma] = await members('马路人');
    const token = await api.login(ma.email);
    const cap = await capture(async () => {
      await api.post(`/api/users/${adminId}/disable`, {}, token);      // 403，不是管理员
      await api.post(`/api/users/${adminId}/disable`, {}, admin);      // 400，不能停用自己
    });

    assert.deepEqual(rowsFor(cap, 'admin.user.disabled'), []);
  });

  it('建群、加人、移除成员都留痕，但只记 id 不记群名和人名', async () => {
    const [a, b] = await members('甲成员', '乙成员');

    const cap = await capture(async () => {
      const created = await api.post('/api/conversations/group', { title: '审计群', memberIds: [a.id] }, admin);
      const id = created.body.conversation.id;
      await api.post(`/api/conversations/${id}/members`, { userIds: [b.id] }, admin);
      await api.call('DELETE', `/api/conversations/${id}/members/${b.id}`, { token: admin });
      return id;
    });

    const created = oneRow(cap, 'group.created');
    assert.equal(created.actorId, adminId);
    assert.equal(created.conversationId, cap.result);
    assert.equal(created.memberCount, 2, '建群时人数没对上（管理员 + 甲，Aria 退役后新群没有 AI 成员）');

    assert.deepEqual(oneRow(cap, 'group.members_added').targetIds, [b.id]);
    assert.equal(oneRow(cap, 'group.member_removed').targetId, b.id);
    // 群名是用户自己写的内容，不进日志
    assertNoLeak(cap, ['审计群', '甲成员', '乙成员']);
  });
});

describe('埋点 · 错误与 SSE', () => {
  it('5xx 记进日志，带上请求方法和路径', async () => {
    // memberIds 传成字符串会在 handler 里炸出 TypeError（真实存在的未校验入参），
    // 走到 app.js 末尾的错误中间件。哪天有人给这个接口补了校验，这条用例会因为
    // 状态码不再是 500 而失败 —— 到时候换一条还会 500 的路径即可，不要把断言放松掉。
    const cap = await capture(() =>
      api.post('/api/conversations/group', { title: '炸', memberIds: '不是数组' }, admin));

    assert.equal(cap.result.status, 500, '这条路径不再 500 了，请换一条 5xx 路径重写本用例');
    const row = oneRow(cap, 'http.error');
    assert.equal(row.level, 'error');
    assert.equal(row.method, 'POST');
    assert.equal(row.path, '/api/conversations/group');
    assert.equal(row.status, 500);
    assert.ok(row.err?.name, '错误类型没记下来');
    assert.ok(row.err?.message && row.err.message !== '[已隐去]', `错误信息被吞了：${JSON.stringify(row.err)}`);
    assert.ok(row.reqId, '5xx 没带 reqId，用户报障时对不上是哪一次请求');
  });

  it('4xx 不记 —— 参数传错是调用方的事，量大且没有排查价值', async () => {
    const cap = await capture(async () => {
      await api.post('/api/conversations/group', { memberIds: [] }, admin);    // 400
      await api.get('/api/conversations/c_不存在', admin);                      // 404
    });
    assert.deepEqual(rowsFor(cap, 'http.error'), []);
  });

  it('SSE 连接建立和断开都留痕', async () => {
    const [shen] = await members('沈实时');
    const token = await api.login(shen.email);

    const cap = await capture(async () => {
      const ac = new AbortController();
      const res = await fetch(`${api.baseUrl}/api/stream?token=${token}`, { signal: ac.signal });
      assert.equal(res.status, 200);
      await new Promise((r) => setTimeout(r, 120));
      ac.abort();
      await new Promise((r) => setTimeout(r, 200));
    });

    assert.equal(oneRow(cap, 'sse.connected').userId, shen.id);
    assert.equal(oneRow(cap, 'sse.disconnected').userId, shen.id);
  });

  it('停用账号时被掐断的连接数记下来，才能确认「立刻掉线」真的生效了', async () => {
    const [yan] = await members('严掉线');
    const token = await api.login(yan.email);

    const cap = await capture(async () => {
      const ac = new AbortController();
      const res = await fetch(`${api.baseUrl}/api/stream?token=${token}`, { signal: ac.signal });
      // 必须握住 body 并持续读：没人引用响应体时 undici 会把连接垃圾回收掉，
      // 慢机器上 GC 一来连接提前断开，停用时就没有连接可掐（CI 上真实发生过）。
      const reader = res.body.getReader();
      const draining = (async () => {
        try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch { /* abort 收尾 */ }
      })();
      await new Promise((r) => setTimeout(r, 120));
      await api.post(`/api/users/${yan.id}/disable`, {}, admin);
      await new Promise((r) => setTimeout(r, 150));
      ac.abort();
      await draining;
    });

    const row = oneRow(cap, 'sse.force_disconnected');
    assert.equal(row.userId, yan.id);
    assert.equal(row.connections, 1);
    // 跟管理动作对着看：同一个人，一条是「谁停用的」，一条是「掐断了几条连接」
    assert.equal(oneRow(cap, 'admin.user.disabled').targetId, yan.id);
  });
});

describe('埋点 · 请求关联 id', () => {
  it('同一次请求里的多条日志共用一个 reqId，不同请求各不相同', async () => {
    const [tang] = await members('唐关联');

    const cap = await capture(async () => {
      await api.post('/api/auth/login', { email: tang.email, password: PASSWORD });
      await api.post('/api/auth/login', { email: tang.email, password: PASSWORD });
    });

    const ids = rowsFor(cap, 'auth.login.ok').map((r) => r.reqId);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1], '两次请求拿到了同一个 reqId');
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}$/);
  });

  it('reqId 回写到响应头，用户报障时念出来就能定位到日志', async () => {
    const res = await fetch(`${api.baseUrl}/api/health`);
    assert.match(res.headers.get('x-request-id') || '', /^[0-9a-f]{8}$/);
  });
});
