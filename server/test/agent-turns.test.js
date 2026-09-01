// hapi Agent 对话全链路：@ 触发 → 判活/开会话 → 递消息 → SSE 收回复 → 贴回聊天。
// Loop IM 服务端是真的，hub 是本地假的（test/hapi-mock.js），事件序列由测试亲手推。
import { startServer, waitFor } from './helpers.js';
import { member } from './fixtures.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMockHub } from './hapi-mock.js';

process.env.HAPI_QUEUE_MAX = '1';            // 排队上限压到 1，好测「排队过多」
process.env.HAPI_TURN_QUIET_MS = '150';      // 文本后安静这么久算收工（测试里别等 5 秒）
process.env.HAPI_TURN_TIMEOUT_MS = '60000';  // 单独的超时用例里再压小
process.env.HAPI_ACTIVE_POLL_MS = '50';      // 等会话 active 的轮询间隔（测试里别真等 1 秒）
process.env.HAPI_AGENTS = 'none';            // 本文件手动启用，避免探测在不同机器上不确定
process.env.HAPI_TZ = 'Asia/Shanghai';       // 补课批次的 [HH:MM] 时间戳按固定时区断言

let api, hub, admin, chen, chenToken, room;

const agentText = (text) => ({
  role: 'agent',
  content: { type: 'codex', data: { type: 'message', message: text } },
});
const messagesOf = async (id, token) => (await api.get(`/api/conversations/${id}/messages`, token)).body.messages;
const lastAgentMessage = async (id, token) => (await messagesOf(id, token)).filter((m) => m.isAI).at(-1);
// 补课批次里每行的 [HH:MM]，与 backlog.js 同一时区规则
const stamp = (ms) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(ms));
const line = (m) => `[${stamp(m.createdAt)}] ${m.senderName}：${m.body}`;

/** 推一整个「回合」的事件：开工 → 文本 → 收工。 */
function pushTurn(sessionId, text) {
  hub.pushEvent({ type: 'session-updated', sessionId, data: { thinking: true } });
  hub.pushEvent({ type: 'message-received', sessionId, message: { id: `hm_${Date.now()}`, content: agentText(text) } });
  hub.pushEvent({ type: 'session-updated', sessionId, data: { thinking: false } });
}

before(async () => {
  hub = await startMockHub();
  process.env.HAPI_BASE_URL = hub.baseUrl;
  process.env.HAPI_TOKEN = 'test-access-token';
  process.env.HAPI_MACHINE_ID = 'm_1';
  process.env.HAPI_WORKROOT = '/tmp/loop-agents';
  hub.state.machines = [hub.onlineMachine('m_1')];

  api = await startServer();
  admin = await api.loginAdmin();
  chen = await member('陈子航');
  chenToken = await api.login(chen.email);

  await api.put('/api/agents/claude', { enabled: true }, admin);
  await api.patch('/api/agents/claude', { name: 'Claude-Code' }, admin);
  // 管理员建群，把成员和 Agent 一起拉进来（D8：只有管理员能拉 Agent）
  const res = await api.post('/api/conversations/group', { title: '发版讨论', memberIds: [chen.id, 'ai-claude'] }, admin);
  assert.equal(res.status, 201);
  room = res.body.conversation;
});
after(async () => { await api.close(); await hub.close(); });

beforeEach(() => {
  hub.state.machines = [hub.onlineMachine('m_1')];
  hub.state.spawnResult = { type: 'success', sessionId: 's_claude_1' };
  hub.state.sessions.set('s_claude_1', { id: 's_claude_1', active: true, thinking: false });
});

describe('群聊 @ 触发', () => {
  it('@Claude-Code → 开会话（目录/agent/yolo 都对）→ 递话是「补课批次」：没 @ 的闲聊一并带上 → 回复贴回群里', async () => {
    // 先铺两条普通聊天：没 @ 它，当时不转发——但它们要随下一次 @ **一起补给它**
    //（D14：不补的话这些消息它永远看不到，只能对着单句硬答，2026-09-01 用户实测踩到）。
    // 每条带 [时间] 署名；人设仍在工作目录的 CLAUDE.md 里，批次之外零注入。
    const m1 = (await api.post(`/api/conversations/${room.id}/messages`, { body: '回归测试只剩一天了' }, admin)).body.message;
    const m2 = (await api.post(`/api/conversations/${room.id}/messages`, { body: '接口还有两项没完成' }, chenToken)).body.message;
    const send = await api.post(`/api/conversations/${room.id}/messages`,
      { body: '@Claude-Code 帮我看看 CI 为什么红了' }, chenToken);
    assert.equal(send.status, 201);
    assert.deepEqual(send.body.message.mentions, ['ai-claude']);

    // hub 侧收到 spawn（第一次没有存过会话）+ 消息
    await waitFor(() => hub.state.lastMessage);
    assert.deepEqual(hub.state.lastSpawn, { machineId: 'm_1', directory: '/tmp/loop-agents/claude', agent: 'claude', yolo: true });
    assert.equal(hub.state.lastMessage.text,
      [line(m1), line(m2), line(send.body.message)].join('\n'),
      '批次 = 上次水位以来的全部消息，最后一条就是 @ 它的这条；每条带 [时间] 署名');

    pushTurn('s_claude_1', '看完了：红在 lint，`no-unused-vars` 两处。');
    const reply = await waitFor(() => lastAgentMessage(room.id, chenToken));
    assert.equal(reply.senderId, 'ai-claude');
    assert.equal(reply.senderName, 'Claude-Code');
    assert.ok(reply.body.includes('红在 lint'));
    // 群里多人可能同时在说话，回帖必须引用触发那条消息，才看得清回的是谁那句
    assert.equal(reply.replyTo, send.body.message.id);
    assert.equal(reply.quote.senderName, '陈子航');
    assert.ok(reply.quote.preview.includes('CI 为什么红了'), '引用摘要里要认得出原话');
  });

  it('第二次 @ 复用已有会话（不再 spawn）；水位之后没别的消息，批次就只有触发这条（自己的回复不重发）', async () => {
    hub.state.lastSpawn = null;
    hub.state.lastMessage = null;
    const send = await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 再确认一下' }, chenToken);
    await waitFor(() => hub.state.lastMessage);
    assert.equal(hub.state.lastSpawn, null, '会话还活着就不该重新 spawn');
    assert.equal(hub.state.lastMessage.text, line(send.body.message),
      '上一批已随发送推了水位，Agent 自己的回帖也不重发——批次里只有新的触发消息');

    const before = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI).length;
    hub.pushEvent({ type: 'session-updated', sessionId: 's_claude_1', data: { thinking: true } });
    hub.pushEvent({ type: 'message-received', sessionId: 's_claude_1', message: { id: 'hm_a', content: agentText('先跑个命令…') } });
    hub.pushEvent({ type: 'message-received', sessionId: 's_claude_1', message: { id: 'hm_b', content: agentText('确认无误，可以发版。') } });
    hub.pushEvent({ type: 'session-updated', sessionId: 's_claude_1', data: { thinking: false } });

    const reply = await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.length > before ? list.at(-1) : null;
    });
    assert.equal(reply.body, '确认无误，可以发版。', '只贴最终那条，不贴中间过程');
  });

  it('干活前的中场白不当回复：工具跑得再久，也等 thinking 收工才贴最终那条', async () => {
    // 真实环境踩过：Agent 先说「我来看一下…」再跑几十秒工具，
    // 「安静几秒算结束」的兜底一响就把中场白贴出去了。
    const before = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI).length;
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 慢慢查，别急着说' }, chenToken);
    await waitFor(() => hub.state.lastMessage?.text.includes('慢慢查'));

    hub.pushEvent({ type: 'session-updated', sessionId: 's_claude_1', data: { thinking: true } });
    hub.pushEvent({ type: 'message-received', sessionId: 's_claude_1', message: { id: 'hm_mid', content: agentText('我来看一下目录内容。') } });
    // 比 HAPI_TURN_QUIET_MS（150ms）长得多的「工具时间」：兜底若没被 thinking 拦住，这里就会误收工
    await new Promise((r) => setTimeout(r, 500));
    const midway = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
    assert.equal(midway.length, before, '工具还在跑，中场白不该被贴出去');

    hub.pushEvent({ type: 'message-received', sessionId: 's_claude_1', message: { id: 'hm_fin', content: agentText('查完了：目录是空的。') } });
    hub.pushEvent({ type: 'session-updated', sessionId: 's_claude_1', data: { thinking: false } });
    const reply = await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.length > before ? list.at(-1) : null;
    });
    assert.equal(reply.body, '查完了：目录是空的。');
  });

  it('@某个人不触发 Agent；@全员 也不触发', async () => {
    hub.state.lastMessage = null;
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@陈子航 @全员 都看一下' }, admin);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hub.state.lastMessage, null);
  });

  it('会话死了先 resume；resume 失败就地重开新会话', async () => {
    hub.state.sessions.set('s_claude_1', { id: 's_claude_1', active: false, thinking: false });
    hub.state.spawnResult = { type: 'success', sessionId: 's_claude_2' };
    hub.state.lastMessage = null;
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 还在吗' }, chenToken);
    await waitFor(() => hub.state.lastMessage);
    // mock 的 resume 直接成功（返回原 id），所以这里走的是 resume 路径、没有 spawn
    assert.ok(hub.state.requests.some((r) => r.path === '/api/sessions/s_claude_1/resume'));
    pushTurn('s_claude_1', '在的。');
    await waitFor(async () => (await lastAgentMessage(room.id, chenToken))?.body === '在的。');
  });
});

describe('群聊补课（D14：没 @ 的消息随下一次 @ 一起送达）', () => {
  // 用独立的群和独立的 hapi 会话 id，水位从零开始，别和上面的用例串数据。
  let room2;
  const useRoom2Session = () => {
    hub.state.spawnResult = { type: 'success', sessionId: 's_claude_r2' };
    hub.state.sessions.set('s_claude_r2', { id: 's_claude_r2', active: true, thinking: false });
  };
  before(async () => {
    const res = await api.post('/api/conversations/group', { title: '补课验证', memberIds: [chen.id, 'ai-claude'] }, admin);
    assert.equal(res.status, 201);
    room2 = res.body.conversation;
    // 「其他 AI 的消息带上」那条要以 ai-codex 的名义插一条消息，先把这个用户造出来
    //（开一下再关：用户行会留着，名字是默认的 Codex）。
    await api.put('/api/agents/codex', { enabled: true }, admin);
    await api.put('/api/agents/codex', { enabled: false }, admin);
  });

  it('没 @ 的当时不转发；下次被 @ 时补上——自己的回帖不重发，其他 AI 的消息带上', async () => {
    useRoom2Session();
    hub.state.lastMessage = null;
    const idle = (await api.post(`/api/conversations/${room2.id}/messages`, { body: '你们感觉有点傻傻的呢' }, admin)).body.message;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hub.state.lastMessage, null, '没 @ 它的消息不实时转发');

    const first = (await api.post(`/api/conversations/${room2.id}/messages`, { body: '@Claude-Code 我发的消息 没看到吗' }, chenToken)).body.message;
    await waitFor(() => hub.state.lastMessage);
    assert.equal(hub.state.lastMessage.sessionId, 's_claude_r2');
    assert.equal(hub.state.lastMessage.text, [line(idle), line(first)].join('\n'),
      '被 @ 时把之前没送达的一并补上，谁说的、几点说的都在');
    pushTurn('s_claude_r2', '这次看到了。');
    await waitFor(async () => (await lastAgentMessage(room2.id, chenToken))?.body === '这次看到了。');

    // 第二轮：期间有普通消息 + 另一个 AI 的发言；Agent 自己的「这次看到了。」不重发
    const { run: dbRun, uid, now: dbNow } = await import('../src/db.js');
    const extra = (await api.post(`/api/conversations/${room2.id}/messages`, { body: '补充一点' }, admin)).body.message;
    const codexAt = dbNow();
    dbRun('INSERT INTO messages (id, conversation_id, sender_id, body, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      uid('m'), room2.id, 'ai-codex', '我插一句', '[]', codexAt);
    hub.state.lastMessage = null;
    const second = (await api.post(`/api/conversations/${room2.id}/messages`, { body: '@Claude-Code 再看看' }, chenToken)).body.message;
    await waitFor(() => hub.state.lastMessage);
    assert.equal(hub.state.lastMessage.text,
      [line(extra), `[${stamp(codexAt)}] Codex：我插一句`, line(second)].join('\n'),
      '水位之后的都补：普通消息、其他 AI 的发言；自己的回帖和更早的批次不重发');
    pushTurn('s_claude_r2', '都看到了。');
    await waitFor(async () => (await lastAgentMessage(room2.id, chenToken))?.body === '都看到了。');
  });

  it('批次里的站内附件降级成占位：图变 [图片]、文件变 [文件：名字]', async () => {
    useRoom2Session();
    const media = (await api.post(`/api/conversations/${room2.id}/messages`,
      { body: '看下这个 ![截图](/uploads/k1.png) 和 [报告.pdf](/uploads/k2)' }, chenToken)).body.message;
    hub.state.lastMessage = null;
    const ask = (await api.post(`/api/conversations/${room2.id}/messages`, { body: '@Claude-Code 附件看到没' }, chenToken)).body.message;
    await waitFor(() => hub.state.lastMessage);
    assert.equal(hub.state.lastMessage.text,
      [`[${stamp(media.createdAt)}] 陈子航：看下这个 [图片] 和 [文件：报告.pdf]`, line(ask)].join('\n'),
      'Agent 反正取不到站内 URL，占位比一串死链干净');
    pushTurn('s_claude_r2', '看到占位了。');
    await waitFor(async () => (await lastAgentMessage(room2.id, chenToken))?.body === '看到占位了。');
  });

  it('递话失败（暂不可用）不推水位：恢复后下次被 @，漏掉的那条会重新补上', async () => {
    hub.state.machines = [];
    await api.get('/api/agents', admin);                    // 对账 → ai-claude 联动停用
    const missed = (await api.post(`/api/conversations/${room2.id}/messages`, { body: '@Claude-Code 这条会失败' }, chenToken)).body.message;
    await waitFor(async () => {
      const last = await lastAgentMessage(room2.id, chenToken);
      return last?.body.includes('暂不可用') ? true : null;
    });

    hub.state.machines = [hub.onlineMachine('m_1')];
    await api.get('/api/agents', admin);                    // 恢复在线
    useRoom2Session();
    hub.state.lastMessage = null;
    const retry = (await api.post(`/api/conversations/${room2.id}/messages`, { body: '@Claude-Code 现在再试' }, chenToken)).body.message;
    await waitFor(() => hub.state.lastMessage);
    assert.equal(hub.state.lastMessage.text, [line(missed), line(retry)].join('\n'),
      '失败那轮没推水位，那条消息这次重新送到——宁可重见，不能永久丢');
    pushTurn('s_claude_r2', '补上了。');
    await waitFor(async () => (await lastAgentMessage(room2.id, chenToken))?.body === '补上了。');
  });
});

describe('Agent 私聊', () => {
  it('不用 @，每条都响应；回复带私聊前缀', async () => {
    const dm = (await api.post('/api/conversations/direct', { userId: 'ai-claude' }, chenToken)).body.conversation;
    assert.equal(dm.type, 'ai');
    hub.state.lastMessage = null;
    hub.state.spawnResult = { type: 'success', sessionId: 's_claude_dm' };   // 私聊是独立的 hapi 会话
    await api.post(`/api/conversations/${dm.id}/messages`, { body: '帮我总结今天的排期' }, chenToken);
    await waitFor(() => hub.state.lastMessage);
    assert.equal(hub.state.lastMessage.sessionId, 's_claude_dm', '私聊有自己的会话，不和群混');
    assert.equal(hub.state.lastMessage.text, '帮我总结今天的排期', '私聊原文直达：不加署名、不加开场白');

    pushTurn('s_claude_dm', '排期总结：……');
    const reply = await waitFor(async () => {
      const last = await lastAgentMessage(dm.id, chenToken);
      return last?.body.includes('排期总结') ? last : null;
    });
    // 私聊一对一，回的是谁那句本来就清楚，引用反而累赘——不带 replyTo
    assert.equal(reply.replyTo, null);
  });
});

describe('不可用与超时', () => {
  it('机器离线（用户已联动停用）→ 回固定的「暂不可用」文案', async () => {
    hub.state.machines = [];
    await api.get('/api/agents', admin);                 // 触发一次对账，让 ai-claude 停用
    const before = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI).length;
    const send = await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 在吗' }, chenToken);
    const reply = await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.length > before ? list.at(-1) : null;
    });
    assert.equal(reply.body, 'Claude-Code 暂不可用，请联系管理员');
    // 失败文案更要引用触发消息——没办成事的时候，得指明「没办成的是哪条」
    assert.equal(reply.replyTo, send.body.message.id);

    hub.state.machines = [hub.onlineMachine('m_1')];
    await api.get('/api/agents', admin);                 // 恢复，别影响后面的用例
  });

  it('开会话失败（spawn 报错）→ 同样是「暂不可用」', async () => {
    hub.state.sessions.delete('s_claude_1');
    const { run } = await import('../src/db.js');
    run(`UPDATE hapi_agents SET session_id = NULL WHERE agent_key = 'claude'`);
    hub.state.spawnResult = { type: 'error', message: 'claude not installed' };
    const before = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI).length;
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 试试' }, chenToken);
    const reply = await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.length > before ? list.at(-1) : null;
    });
    assert.equal(reply.body, 'Claude-Code 暂不可用，请联系管理员');
  });

  it('超时（事件迟迟不来）→ 「处理超时」文案', async () => {
    process.env.HAPI_TURN_TIMEOUT_MS = '400';
    try {
      hub.state.spawnResult = { type: 'success', sessionId: 's_claude_1' };
      hub.state.sessions.set('s_claude_1', { id: 's_claude_1', active: true, thinking: false });
      const before = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI).length;
      await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 这条没人理' }, chenToken);
      const reply = await waitFor(async () => {
        const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
        return list.length > before ? list.at(-1) : null;
      }, { timeout: 5000 });
      assert.match(reply.body, /处理超时/);
    } finally {
      process.env.HAPI_TURN_TIMEOUT_MS = '60000';
    }
  });

  it('回合结束但一个字都没说 → 「没有返回文字回复」', async () => {
    const before = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI).length;
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 干个活' }, chenToken);
    await waitFor(() => hub.state.lastMessage?.text.includes('干个活'));
    hub.pushEvent({ type: 'session-updated', sessionId: 's_claude_1', data: { thinking: true } });
    hub.pushEvent({ type: 'session-updated', sessionId: 's_claude_1', data: { thinking: false } });
    const reply = await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.length > before ? list.at(-1) : null;
    });
    assert.match(reply.body, /没有返回文字回复/);
  });
});

describe('排队与限流', () => {
  it('Agent 进程启动慢（spawn 后几百毫秒才 active）→ 等到 active 再发，不吃 409', async () => {
    // 换一个还没会话的 Agent 走全新 spawn：codex
    await api.put('/api/agents/codex', { enabled: true }, admin);
    await api.post(`/api/conversations/${room.id}/members`, { userIds: ['ai-codex'] }, admin);
    hub.state.spawnResult = { type: 'success', sessionId: 's_codex_slow' };
    hub.state.sessions.set('s_codex_slow', { id: 's_codex_slow', active: false, thinking: false });
    setTimeout(() => { hub.state.sessions.get('s_codex_slow').active = true; }, 300);

    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Codex 慢启动也别丢' }, chenToken);
    await waitFor(() => hub.state.lastMessage?.text.includes('慢启动也别丢'), { timeout: 6000 });
    pushTurn('s_codex_slow', '起来了，收到。');
    await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.some((m) => m.body === '起来了，收到。') ? true : null;
    });
    // 收尾：把 codex 停掉，避免影响别的用例
    await api.put('/api/agents/codex', { enabled: false }, admin);
    hub.state.spawnResult = { type: 'success', sessionId: 's_claude_1' };
  });

  it('队列满（HAPI_QUEUE_MAX=1）时第二条立刻回「排队请求过多」，第一条照常完成', async () => {
    // 第一条占住队列：不推事件，让它一直等
    const before = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI).length;
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 第一件事' }, chenToken);
    await waitFor(() => hub.state.lastMessage?.text.includes('第一件事'));

    // 第二条进不了队列 → 立刻回话
    const second = await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 第二件事' }, admin);
    const busy = await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.find((m) => m.body.includes('排队请求过多')) || null;
    });
    assert.equal(busy.body, 'Claude-Code 排队请求过多，请稍后再试');
    assert.equal(busy.replyTo, second.body.message.id, '队列满的即时回话也要指明回的是哪条');

    // 放第一条走完，别拖住后面的用例
    pushTurn('s_claude_1', '第一件事办完了。');
    await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.length >= before + 2 ? true : null;
    });
  });

  it("触发 Agent 的消息走更严的 'ai' 限流档，超了 429 且消息不入库", async () => {
    // 限流按人计数，前面的用例已经替 chen 消耗过额度——换一个全新成员来测
    const fresh = await member('额度专用');
    const freshToken = await api.login(fresh.email);
    await api.post(`/api/conversations/${room.id}/members`, { userIds: [fresh.id] }, admin);
    const limit = await import('../src/usage-limit.js');
    const restore = limit.configureUsageLimit('ai', { max: 1, windowMs: 60_000 });
    try {
      const first = await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 额度一' }, freshToken);
      assert.equal(first.status, 201);
      await waitFor(() => hub.state.lastMessage?.text.includes('额度一'));
      pushTurn('s_claude_1', '收到。');

      const second = await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 额度二' }, freshToken);
      assert.equal(second.status, 429);
      assert.ok(second.body.retryAfterMs > 0);
      const bodies = (await messagesOf(room.id, freshToken)).map((m) => m.body);
      assert.ok(!bodies.includes('@Claude-Code 额度二'), '被限流的消息不该入库');

      // 不触发 Agent 的普通消息不受 'ai' 档影响
      assert.equal((await api.post(`/api/conversations/${room.id}/messages`, { body: '普通消息照发' }, freshToken)).status, 201);
    } finally {
      restore();
    }
  });
});

describe('「输入中」带上是谁在干活（ai-typing 的 agents 字段）', () => {
  // 这两条直接调 runAgentTurns、用 deps 注入假的 emit/ensure/send/wait：
  // 要盯的是 setTyping 的聚合逻辑本身，走完整 HTTP + SSE 反而抓不住事件顺序。
  // 会话 id 用独享的，别和上面用例共享队列与计数。

  it('开工时 agents 含该 Agent 的 id/name；收工后 typing=false 且 agents 为空', async () => {
    const { runAgentTurns } = await import('../src/hapi/turns.js');
    const events = [];
    let finish;                                  // 捏在测试手里的「收工」开关
    const deps = {
      emit: (audience, type, payload) => { if (type === 'ai-typing') events.push(payload); },
      ensure: async () => ({ sessionId: 's_typing_solo' }),
      send: async () => {},
      wait: () => ({
        ready: Promise.resolve(),
        promise: new Promise((resolve) => { finish = () => resolve({ kind: 'done', text: '看完了。' }); }),
      }),
    };
    runAgentTurns({
      convo: { id: 'c_typing_solo', type: 'group' },
      sender: { id: chen.id, name: '陈子航', role: 'member' },
      body: '@Claude-Code 谁在忙',
      roster: [], audience: [chen.id],
      targets: [{ key: 'claude', userId: 'ai-claude', name: 'Claude-Code' }],
      postReply: () => {},
    }, deps);

    await waitFor(() => (events.length >= 1 ? true : null));
    assert.deepEqual(events[0], {
      conversationId: 'c_typing_solo', typing: true,
      agents: [{ id: 'ai-claude', name: 'Claude-Code' }],
    }, '开工的那份事件要指名道姓');

    await waitFor(() => (finish ? true : null));   // 等 job 真正挂上 wait，收工开关才在手里
    finish();
    await waitFor(() => (events.length >= 2 ? true : null));
    assert.deepEqual(events[1], { conversationId: 'c_typing_solo', typing: false, agents: [] },
      '收工后 typing 熄灯（老语义不变），agents 也清空');
  });

  it('两个 Agent 并行：agents 按开工顺序聚合，先收工的只摘掉自己、灯不灭', async () => {
    // codex 在前面的用例里被停掉了，这条要它真的能进 job，先启回来
    await api.put('/api/agents/codex', { enabled: true }, admin);
    try {
      const { runAgentTurns } = await import('../src/hapi/turns.js');
      const events = [];
      const finishers = new Map();               // sessionId -> 收工开关
      const deps = {
        emit: (audience, type, payload) => { if (type === 'ai-typing') events.push(payload); },
        ensure: async (key) => ({ sessionId: `s_typing_${key}` }),
        send: async () => {},
        wait: ({ sessionId }) => ({
          ready: Promise.resolve(),
          promise: new Promise((resolve) => {
            finishers.set(sessionId, () => resolve({ kind: 'done', text: '收工。' }));
          }),
        }),
      };
      runAgentTurns({
        convo: { id: 'c_typing_duo', type: 'group' },
        sender: { id: chen.id, name: '陈子航', role: 'member' },
        body: '@Claude-Code @Codex 一起上',
        roster: [], audience: [chen.id],
        // 两个 Agent 各有各的队列（按「Agent × 会话」分），所以是真并行
        targets: [
          { key: 'claude', userId: 'ai-claude', name: 'Claude-Code' },
          { key: 'codex', userId: 'ai-codex', name: 'Codex' },
        ],
        postReply: () => {},
      }, deps);

      await waitFor(() => (events.length >= 2 ? true : null));
      assert.deepEqual(events[1].agents,
        [{ id: 'ai-claude', name: 'Claude-Code' }, { id: 'ai-codex', name: 'Codex' }],
        '两个都开工后，名单按开工顺序列全');

      // 先放 claude 收工：codex 的灯不能被关掉——这正是当年按会话计数要防的事
      await waitFor(() => (finishers.size === 2 ? true : null));
      finishers.get('s_typing_claude')();
      await waitFor(() => (events.length >= 3 ? true : null));
      assert.deepEqual(events[2], {
        conversationId: 'c_typing_duo', typing: true,
        agents: [{ id: 'ai-codex', name: 'Codex' }],
      }, '先收工的只摘掉自己，还在干活的照亮');

      finishers.get('s_typing_codex')();
      await waitFor(() => (events.length >= 4 ? true : null));
      assert.deepEqual(events[3], { conversationId: 'c_typing_duo', typing: false, agents: [] });
    } finally {
      await api.put('/api/agents/codex', { enabled: false }, admin);   // 恢复原状，别影响别的用例
    }
  });
});

describe('触发判定（agentTargetsFor 纯函数）', () => {
  it('AI 发的消息永不触发（D5）；没有 Agent 的会话返回空', async () => {
    const { agentTargetsFor } = await import('../src/hapi/turns.js');
    const roster = [
      { id: 'u_1', name: '张三', role: 'member' },
      { id: 'ai-claude', name: 'Claude-Code', role: 'ai' },
    ];
    assert.deepEqual(agentTargetsFor({
      convo: { type: 'group' }, roster, mentions: ['ai-claude'],
      sender: { id: 'ai-codex', role: 'ai' },
    }), []);
    assert.deepEqual(agentTargetsFor({
      convo: { type: 'group' }, roster: [roster[0]], mentions: ['all'],
      sender: { id: 'u_1', role: 'member' },
    }), []);
    // 一条消息 @ 到 Agent → 命中，带上 key/userId/name
    assert.deepEqual(agentTargetsFor({
      convo: { type: 'group' }, roster, mentions: ['ai-claude', 'u_1'],
      sender: { id: 'u_1', role: 'member' },
    }), [{ key: 'claude', userId: 'ai-claude', name: 'Claude-Code' }]);
  });
});
