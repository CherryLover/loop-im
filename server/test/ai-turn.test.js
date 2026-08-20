// 响应已经发出之后才跑的那段 AI 工作（runAiTurn）必须自成一体：
// 内部任何一步出错都不能把 rejection 抛回 Express——否则错误中间件会往一个
// headersSent 的响应上再写一次，撞出 ERR_HTTP_HEADERS_SENT，把真实故障盖掉。
import { startServer, waitFor } from './helpers.js';
import { group, member } from './fixtures.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, token, chen, zhou, convo, runAiTurn, subscribe;

before(async () => {
  api = await startServer();
  token = await api.loginAdmin();
  ({ runAiTurn } = await import('../src/routes/conversations.js'));
  ({ subscribe } = await import('../src/events.js'));
  chen = await member('陈子航', { dept: '后端' });
  zhou = await member('周明', { dept: '前端' });
  convo = await group(api, token, '发版协作', [chen.id, zhou.id]);
});
after(async () => { await api.close(); });

// ---- 工具 ---------------------------------------------------------------

/** 假的 SSE 连接：记录收到的事件，可以让指定的一次写入抛错。 */
function fakeClient(userId, { failOn = () => false } = {}) {
  const received = [];
  let onClose = () => {};
  const res = {
    writeHead() {},
    write(payload) {
      const event = payload.match(/^event: (.+)$/m)?.[1];
      if (!event) return true;                       // ": connected" / ": ping"
      const data = JSON.parse(payload.match(/^data: (.+)$/m)[1]);
      if (failOn(event, data)) throw new Error('SSE 写入失败');
      received.push({ event, data });
      return true;
    },
    on(name, fn) { if (name === 'close') onClose = fn; },
  };
  subscribe(userId, res);
  return {
    received,
    typings: () => received.filter((e) => e.event === 'ai-typing').map((e) => e.data.typing),
    close: () => onClose(),                          // 清掉 ping 定时器并从连接表里摘掉
  };
}

/** 捕捉进程级的 unhandledRejection / uncaughtException（headers-sent 就是这么冒出来的）。 */
function watchProcessErrors() {
  const seen = [];
  const push = (err) => seen.push(err);
  process.on('unhandledRejection', push);
  process.on('uncaughtException', push);
  return {
    seen,
    async settle() {                                  // 给 rejection 一点冒出来的时间
      for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 30));
      process.off('unhandledRejection', push);
      process.off('uncaughtException', push);
      return seen;
    },
  };
}

const aiRow = (body) => ({
  id: 'm_fake', conversation_id: convo.id, sender_id: 'ai', body, mentions: '[]', created_at: 1,
});

/** 一个最小可用的依赖集合，各条用例只覆盖自己关心的那一项。 */
function deps(overrides = {}) {
  const calls = { learn: [], generate: [], insert: [], emits: [], errors: [] };
  const base = {
    learn: async (...args) => { calls.learn.push(args); },
    generate: async (...args) => { calls.generate.push(args); return { body: 'Aria 的回复', mode: 'stub' }; },
    insert: (conversationId, body) => { calls.insert.push([conversationId, body]); return aiRow(body); },
    emit: (audience, event, data) => { calls.emits.push({ event, data }); },
    onError: (err) => { calls.errors.push(err); },
  };
  return { calls, deps: { ...base, ...overrides } };
}

const ctx = () => ({
  convo: { id: convo.id, type: 'group' },
  userId: chen.id,
  audience: [chen.id, zhou.id, 'ai'],
  mentions: ['ai'],
  settings: { allow_dm: 1, reply_at_all: 0, silent_read: 1 },
});

const typingsOf = (calls) => calls.emits.filter((e) => e.event === 'ai-typing').map((e) => e.data.typing);

// ---- 单元：后台流程绝不向外抛 --------------------------------------------

describe('runAiTurn 的隔离性', () => {
  let watch;
  beforeEach(() => { watch = watchProcessErrors(); });

  it('正常路径：学习画像、生成回复、插库并广播，ai-typing 成对发出', async () => {
    const { calls, deps: d } = deps();
    await runAiTurn(ctx(), d);

    assert.deepEqual(calls.learn, [[chen.id, ctx().convo]]);
    assert.equal(calls.generate.length, 1);
    assert.deepEqual(calls.insert, [[convo.id, 'Aria 的回复']]);
    assert.deepEqual(calls.emits.map((e) => e.event), ['ai-typing', 'message', 'ai-typing']);
    assert.deepEqual(typingsOf(calls), [true, false]);

    const { message } = calls.emits[1].data;
    assert.equal(message.body, 'Aria 的回复');
    assert.equal(message.senderName, 'Aria');
    assert.equal(message.isAI, true);
    assert.deepEqual(calls.errors, []);
    assert.deepEqual(await watch.settle(), []);
  });

  it('generateReply 失败：不抛出，仍然发出 ai-typing:false', async () => {
    const { calls, deps: d } = deps({ generate: async () => { throw new Error('供应商炸了'); } });
    await runAiTurn(ctx(), d);                        // 不抛就是通过

    assert.deepEqual(typingsOf(calls), [true, false]);
    assert.equal(calls.insert.length, 0);
    assert.equal(calls.errors.length, 1);
    assert.match(calls.errors[0].message, /供应商炸了/);
    assert.deepEqual(await watch.settle(), []);
  });

  it('insertAiMessage 写库失败：不抛出，仍然发出 ai-typing:false', async () => {
    const { calls, deps: d } = deps({ insert: () => { throw new Error('SQLITE_BUSY'); } });
    await runAiTurn(ctx(), d);

    assert.deepEqual(typingsOf(calls), [true, false]);
    assert.equal(calls.errors.length, 1);
    assert.match(calls.errors[0].message, /SQLITE_BUSY/);
    assert.deepEqual(await watch.settle(), []);
  });

  it('emitTo 每次都失败（含 finally 里那次）：依旧不抛出，三次写入都被兜住', async () => {
    const attempted = [];
    const { calls, deps: d } = deps({
      emit: (_audience, event, data) => { attempted.push({ event, data }); throw new Error('SSE 写入失败'); },
    });
    await runAiTurn(ctx(), d);

    assert.deepEqual(attempted.map((e) => e.event), ['ai-typing', 'message', 'ai-typing']);
    assert.deepEqual(attempted.filter((e) => e.event === 'ai-typing').map((e) => e.data.typing), [true, false]);
    assert.equal(calls.errors.length, 3);
    assert.deepEqual(await watch.settle(), []);
  });

  it('learnAbout 失败（异步 reject 与同步抛）都不会逃逸', async () => {
    const rejecting = deps({ learn: async () => { throw new Error('画像更新失败'); } });
    await runAiTurn(ctx(), rejecting.deps);
    assert.equal(rejecting.calls.errors.length, 1);
    assert.deepEqual(typingsOf(rejecting.calls), [true, false]);
    assert.equal(rejecting.calls.insert.length, 1, '学习失败不应影响回复');

    const throwing = deps({ learn: () => { throw new Error('同步就炸了'); } });
    await runAiTurn(ctx(), throwing.deps);
    assert.equal(throwing.calls.errors.length, 1);
    assert.equal(throwing.calls.insert.length, 1);

    assert.deepEqual(await watch.settle(), []);
  });

  it('没被 @ 的群消息：只学习，不发 ai-typing 也不回复', async () => {
    const { calls, deps: d } = deps();
    await runAiTurn({ ...ctx(), mentions: ['u_zhou'] }, d);

    assert.equal(calls.learn.length, 1);
    assert.deepEqual(calls.emits, []);
    assert.equal(calls.generate.length, 0);
    assert.deepEqual(await watch.settle(), []);
  });

  it('测试环境下默认的错误处理不往 stderr 打东西', async () => {
    const original = console.error;
    const printed = [];
    console.error = (...args) => printed.push(args);
    try {
      await runAiTurn(ctx(), { insert: () => { throw new Error('写库失败'); } });  // onError 用默认实现
    } finally {
      console.error = original;
    }
    assert.deepEqual(printed, [], 'NODE_ENV=test 时不应打印，否则污染测试输出');
    assert.deepEqual(await watch.settle(), []);
  });
});

// ---- 端到端：走真实的 POST /:id/messages ---------------------------------

describe('POST /:id/messages 的响应不受后台 AI 流程影响', () => {
  it('广播 AI 回复时 SSE 写入失败：错误中间件不掺和，不会撞出 ERR_HTTP_HEADERS_SENT', async () => {
    const watch = watchProcessErrors();
    // 陈子航这条连接在广播 AI 回复时写失败；周明那条只负责记录。
    const broken = fakeClient(chen.id, { failOn: (event, data) => event === 'message' && data.message.isAI });
    const witness = fakeClient(zhou.id);
    const chenToken = await api.login(chen.email);

    // app.js 的错误中间件在 NODE_ENV=test 时是哑的，这里临时摘掉这层静音，
    // 好看清「响应之后的错误有没有被交给错误中间件」——交给了就会打出一条裸的 Error，
    // 那条路径的下一步正是 res.status().json() 撞上 ERR_HTTP_HEADERS_SENT。
    const originalEnv = process.env.NODE_ENV;
    const originalError = console.error;
    const printed = [];
    process.env.NODE_ENV = 'development';
    console.error = (...args) => printed.push(args);

    let res;
    try {
      res = await api.post(`/api/conversations/${convo.id}/messages`, { body: '@Aria 看下发版风险' }, chenToken);
      await waitFor(async () => witness.typings().includes(false) || null);
      await watch.settle();
    } finally {
      console.error = originalError;
      process.env.NODE_ENV = originalEnv;
      broken.close();
      witness.close();
    }

    assert.equal(res.status, 201, '发消息接口本身仍然返回 201');
    assert.equal(res.body.message.body, '@Aria 看下发版风险');
    assert.deepEqual(res.body.message.mentions, ['ai']);
    assert.deepEqual(witness.typings(), [true, false], 'ai-typing 仍要成对发出，前端不会卡在「正在输入」');

    const reports = printed.filter(([first]) => typeof first === 'string' && first.startsWith('[ai-turn]'));
    assert.deepEqual(
      printed.filter((args) => !reports.includes(args)).map(([e]) => e?.message || String(e)), [],
      '响应之后的错误不该再走到 Express 的错误中间件（那一步会撞出 ERR_HTTP_HEADERS_SENT）',
    );
    assert.equal(reports.length, 1, '出错应当在服务端留下一条 ai-turn 的痕迹');
    assert.match(reports[0][1].message, /SSE 写入失败/);
    assert.deepEqual(
      watch.seen.map((e) => e?.code || e?.message), [],
      '也不该冒出进程级的 unhandledRejection / uncaughtException',
    );
  });

  it('正常路径：201 照常返回，AI 回复照常插库并广播', async () => {
    const watch = watchProcessErrors();
    const witness = fakeClient(zhou.id);
    const chenToken = await api.login(chen.email);

    const res = await api.post(`/api/conversations/${convo.id}/messages`, { body: '@Aria 再确认一下排期' }, chenToken);
    assert.equal(res.status, 201);
    assert.equal(res.body.message.isAI, false);

    const stored = await waitFor(async () => {
      const { body } = await api.get(`/api/conversations/${convo.id}/messages`, chenToken);
      return body.messages.filter((m) => m.isAI).at(-1);
    });
    assert.equal(stored.senderName, 'Aria');
    assert.ok(stored.body.length > 0);

    await waitFor(async () => witness.received.some((e) => e.event === 'message' && e.data.message.isAI) || null);
    assert.deepEqual(witness.typings(), [true, false]);

    const errors = await watch.settle();
    witness.close();
    assert.deepEqual(errors, []);
  });
});
