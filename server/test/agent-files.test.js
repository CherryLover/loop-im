// 附件双向摆渡（D16，src/hapi/files.js）：用户发的站内附件传进 hapi 会话、
// 正文链接换成 runner 路径说明；Agent 用 display_image 交付的图片下载回来、
// 存成我们的附件、以它的名义贴进聊天。hub 是假的（hapi-mock），服务端是真的。
import { startServer, waitFor } from './helpers.js';
import { member } from './fixtures.js';
import { pngOfSize } from './samples.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMockHub } from './hapi-mock.js';

process.env.HAPI_QUEUE_MAX = '5';
process.env.HAPI_TURN_QUIET_MS = '150';
process.env.HAPI_TURN_TIMEOUT_MS = '60000';
process.env.HAPI_ACTIVE_POLL_MS = '50';
process.env.HAPI_AGENTS = 'none';

let api, hub, admin, chen, chenToken, room, dm;
let shot;                                                   // chen 传上来的那张图 { url, filename }
const SHOT_BYTES = 4096;

const agentText = (text) => ({
  role: 'agent',
  content: { type: 'codex', data: { type: 'message', message: text } },
});
const generatedImage = (imageId, fileName) => ({
  role: 'agent',
  content: { type: 'codex', data: { type: 'generated-image', imageId, fileName, mimeType: 'image/png' } },
});
const messagesOf = async (id, token) => (await api.get(`/api/conversations/${id}/messages`, token)).body.messages;
const agentMessages = async (id, token) => (await messagesOf(id, token)).filter((m) => m.isAI);

function pushTurn(sessionId, text) {
  hub.pushEvent({ type: 'session-updated', sessionId, data: { thinking: true } });
  hub.pushEvent({ type: 'message-received', sessionId, message: { id: `hm_${Math.random().toString(36).slice(2)}`, content: agentText(text) } });
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
  room = (await api.post('/api/conversations/group', { title: '附件摆渡群', memberIds: [chen.id, 'ai-claude'] }, admin)).body.conversation;
  dm = (await api.post('/api/conversations/direct', { userId: 'ai-claude' }, chenToken)).body.conversation;

  // chen 先传一张真实 PNG，后面的用例都引用它
  const form = new FormData();
  form.append('file', new Blob([pngOfSize(SHOT_BYTES)], { type: 'image/png' }), 'shot.png');
  const up = await api.call('POST', '/api/uploads', { token: chenToken, form });
  assert.equal(up.status, 201);
  shot = up.body;
});
after(async () => { await api.close(); await hub.close(); });

describe('用户 → Agent（附件传进会话）', () => {
  it('私聊发图：文件以 Base64 传给 hub、正文链接换成 runner 路径、消息带附件元数据', async () => {
    hub.state.spawnResult = { type: 'success', sessionId: 's_dm' };
    hub.state.sessions.set('s_dm', { id: 's_dm', active: true, thinking: false });
    hub.state.lastMessage = null;

    await api.post(`/api/conversations/${dm.id}/messages`, { body: `看下这张 ![shot.png](${shot.url})` }, chenToken);
    await waitFor(() => hub.state.lastMessage);

    const uploaded = hub.state.uploads.at(-1);
    assert.equal(uploaded.sessionId, 's_dm');
    assert.equal(uploaded.filename, 'shot.png');
    assert.equal(uploaded.mimeType, 'image/png');
    assert.equal(Buffer.from(uploaded.content, 'base64').length, SHOT_BYTES, '传给 hub 的就是存储里的原始字节');

    const text = hub.state.lastMessage.text;
    assert.ok(text.includes('已放到：/tmp/hapi-blobs/'), '链接换成 Agent 能读的路径说明');
    assert.ok(!text.includes('/uploads/'), '内链 URL 不递给 Agent（它打不开）');
    assert.equal(hub.state.lastMessage.attachments?.[0]?.filename, 'shot.png');
    assert.ok(hub.state.lastMessage.attachments[0].path.startsWith('/tmp/hapi-blobs/'));

    pushTurn('s_dm', '图我看到了。');
    await waitFor(async () => (await agentMessages(dm.id, chenToken)).at(-1)?.body === '图我看到了。');
  });

  it('超过大小上限的不传：留占位并注明原因，hub 侧没有多出上传', async () => {
    const uploadsBefore = hub.state.uploads.length;
    process.env.HAPI_ATTACH_MAX_MB = '0';                  // 0MB：任何文件都超限
    try {
      hub.state.lastMessage = null;
      await api.post(`/api/conversations/${dm.id}/messages`, { body: `再看下 ![shot.png](${shot.url})` }, chenToken);
      await waitFor(() => hub.state.lastMessage);
      assert.ok(hub.state.lastMessage.text.includes('超过 0MB，未传入'));
      assert.equal(hub.state.uploads.length, uploadsBefore);
      pushTurn('s_dm', '这张太大了。');
      await waitFor(async () => (await agentMessages(dm.id, chenToken)).at(-1)?.body === '这张太大了。');
    } finally {
      delete process.env.HAPI_ATTACH_MAX_MB;
    }
  });

  it('群聊补课批次里的附件同样摆渡：先发图没 @，再 @ 时图随批次真的送达', async () => {
    hub.state.spawnResult = { type: 'success', sessionId: 's_room' };
    hub.state.sessions.set('s_room', { id: 's_room', active: true, thinking: false });
    hub.state.lastMessage = null;

    await api.post(`/api/conversations/${room.id}/messages`, { body: `![shot.png](${shot.url})` }, chenToken);
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude 看下我刚发的图' }, chenToken);
    await waitFor(() => hub.state.lastMessage);

    assert.equal(hub.state.lastMessage.sessionId, 's_room');
    assert.ok(hub.state.lastMessage.text.includes('已放到：/tmp/hapi-blobs/'), '补课行里的图也换成了路径说明');
    assert.ok(hub.state.uploads.some((u) => u.sessionId === 's_room' && u.filename === 'shot.png'));
    pushTurn('s_room', '收到图了。');
    await waitFor(async () => (await agentMessages(room.id, chenToken)).at(-1)?.body === '收到图了。');
  });
});

describe('Agent → 用户（交付的图片贴回聊天）', () => {
  it('回合里 display_image 的图：收工后下载、存为我们的附件、以 Agent 名义作为图片消息贴出（跟在文字后）', async () => {
    const imageBytes = pngOfSize(2048);
    hub.state.generatedImages = new Map([['img_1', imageBytes]]);
    const before = (await agentMessages(dm.id, chenToken)).length;

    await api.post(`/api/conversations/${dm.id}/messages`, { body: '画一张雨中的超市' }, chenToken);
    await waitFor(() => hub.state.lastMessage?.text.includes('画一张雨中的超市'));

    hub.pushEvent({ type: 'session-updated', sessionId: 's_dm', data: { thinking: true } });
    hub.pushEvent({ type: 'message-received', sessionId: 's_dm', message: { id: 'hm_img', content: generatedImage('img_1', '雨中超市.png') } });
    hub.pushEvent({ type: 'message-received', sessionId: 's_dm', message: { id: 'hm_done', content: agentText('画好了，图在下面。') } });
    hub.pushEvent({ type: 'session-updated', sessionId: 's_dm', data: { thinking: false } });

    const list = await waitFor(async () => {
      const l = await agentMessages(dm.id, chenToken);
      return l.length >= before + 2 ? l : null;
    });
    const [textMsg, imageMsg] = list.slice(-2);
    assert.equal(textMsg.body, '画好了，图在下面。');
    assert.match(imageMsg.body, /^!\[雨中超市\.png\]\(\/uploads\/[A-Za-z0-9._-]+\)$/);
    assert.equal(imageMsg.replyTo, null, '媒体随文字，不重复引用');

    // 附件真的存进了我们的存储，且群成员（chen）有权下载（挂了 attachment_refs）
    const key = imageMsg.body.match(/\/uploads\/([A-Za-z0-9._-]+)/)[1];
    const { get } = await import('../src/db.js');
    const row = get('SELECT * FROM attachments WHERE url = ?', `/uploads/${key}`);
    assert.equal(row.owner_id, 'ai-claude');
    assert.equal(row.bytes, imageBytes.length);
    const { authorizeDownload } = await import('../src/attachment-access.js');
    assert.equal(authorizeDownload(key, { id: chen.id }).ok, true, '会话成员能打开 Agent 发的图');
    const { getObject } = await import('../src/storage.js');
    assert.equal((await getObject(key)).length, imageBytes.length, '字节原样落库');
  });

  it('回合超时但图已交付：超时文案之后图照样贴出——真实产物不能扔', async () => {
    process.env.HAPI_TURN_TIMEOUT_MS = '400';
    try {
      hub.state.generatedImages = new Map([['img_slow', pngOfSize(1024)]]);
      const before = (await agentMessages(dm.id, chenToken)).length;
      await api.post(`/api/conversations/${dm.id}/messages`, { body: '慢慢画一张' }, chenToken);
      await waitFor(() => hub.state.lastMessage?.text.includes('慢慢画一张'));
      hub.pushEvent({ type: 'session-updated', sessionId: 's_dm', data: { thinking: true } });
      hub.pushEvent({ type: 'message-received', sessionId: 's_dm', message: { id: 'hm_slow', content: generatedImage('img_slow', '慢图.png') } });
      // 不推 thinking:false —— 让它超时
      const list = await waitFor(async () => {
        const l = await agentMessages(dm.id, chenToken);
        return l.length >= before + 2 ? l : null;
      }, { timeout: 5000 });
      const [timeoutMsg, imageMsg] = list.slice(-2);
      assert.match(timeoutMsg.body, /处理超时/);
      assert.match(imageMsg.body, /^!\[慢图\.png\]\(\/uploads\//);
    } finally {
      process.env.HAPI_TURN_TIMEOUT_MS = '60000';
    }
  });
});

describe('annotateAttachments（正文注释的纯函数面）', () => {
  it('有摆渡结果用结果，没有退回占位；图与文件的占位形态与 D14 一致', async () => {
    const { annotateAttachments } = await import('../src/hapi/files.js');
    const body = '图 ![a.png](/uploads/k1.png) 和文件 [b.pdf](/uploads/k2)';
    assert.equal(annotateAttachments(body), '图 [图片] 和文件 [文件：b.pdf]');
    assert.equal(
      annotateAttachments(body, (key, name) => (key === 'k1.png' ? `[图片 ${name} 已放到：/x/y]` : null)),
      '图 [图片 a.png 已放到：/x/y] 和文件 [文件：b.pdf]',
    );
  });
});
