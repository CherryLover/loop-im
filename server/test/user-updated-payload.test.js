import './helpers.js';
// 改名 / 换头像之后，界面上所有拷贝了这份资料的地方都要跟着变。前端不再为此整份重拉
// 会话与消息，而是拿 `user-updated` 事件里带的那份 user 就地把手里的拷贝改掉
// （见 web/src/lib/user-sync.ts）。这组用例钉住那条契约的两半：
//
//   1. 广播出去的 payload 必须是**完整的一份 publicUser**（至少 id + name + avatarUrl），
//      而且改名的人自己也收得到 —— 前端靠这一份更新「我」以及别的标签页。
//      哪天有人把它瘦身成 `{ userId }`，前端会静默地再也刷不新，这里先炸。
//   2. 服务端这些字段本来就是 JOIN users 现算的：会话成员、私聊标题、历史消息的
//      senderName / senderAvatarUrl、引用摘要里的名字，重新拉一次全是新名字。
//      也就是说「跟着人变」是既有语义，前端就地改拷贝只是把它对齐，不是改语义。
import { startServer, waitFor } from './helpers.js';
import { direct, group, member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, adminToken, chen, chenToken, lin, linToken;
const openStreams = new Set();

before(async () => {
  api = await startServer();
  adminToken = await api.loginAdmin();
  chen = await member('陈子航', { dept: '后端' });
  lin = await member('林悦', { dept: '产品' });
  chenToken = await api.login(chen.email);
  linToken = await api.login(lin.email);
});
after(async () => {
  for (const stream of [...openStreams]) stream.close();
  await api.close();
});

/** 极简 SSE 客户端：把收到的事件按顺序堆进数组，供断言使用。 */
async function openStream(token) {
  const controller = new AbortController();
  const res = await fetch(`${api.baseUrl}/api/stream?token=${encodeURIComponent(token)}`, {
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const lines = buffer.slice(0, cut).split('\n');
          buffer = buffer.slice(cut + 2);
          const name = lines.find((l) => l.startsWith('event: '));
          const data = lines.find((l) => l.startsWith('data: '));
          if (name && data) events.push({ event: name.slice(7), data: JSON.parse(data.slice(6)) });
        }
      }
    } catch { /* 连接被 abort，正常结束 */ }
  })();
  const stream = { events, close: () => { controller.abort(); openStreams.delete(stream); } };
  openStreams.add(stream);
  return stream;
}

const userUpdatedFor = (stream, userId) => waitFor(
  () => stream.events.find((e) => e.event === 'user-updated' && e.data?.user?.id === userId),
);

describe('user-updated 的 payload 够前端做局部更新', () => {
  it('改名广播的是完整的一份 user，别人和本人都收得到', async () => {
    const watcher = await openStream(linToken);       // 别人
    const self = await openStream(chenToken);         // 改名的人自己
    try {
      const res = await api.patch('/api/auth/me', { name: '陈子航（新）' }, chenToken);
      assert.equal(res.status, 200);

      for (const stream of [watcher, self]) {
        const { data } = await userUpdatedFor(stream, chen.id);
        // 前端就地改拷贝要用到的每一个字段都得在
        assert.equal(data.user.name, '陈子航（新）');
        assert.equal(data.user.id, chen.id);
        assert.equal(data.user.dept, '后端');
        assert.equal(data.user.role, 'member');
        assert.equal(data.user.disabled, false);
        assert.ok('avatarUrl' in data.user, 'payload 必须带 avatarUrl，前端要用它换头像');
      }
    } finally {
      watcher.close();
      self.close();
    }
  });
});

describe('名字与头像在服务端是「跟着人变」，不是发消息时的快照', () => {
  it('改名之后重新拉，会话成员、私聊标题、历史消息的 senderName 全是新名字', async () => {
    const zhou = await member('周原', { dept: '设计' });
    const zhouToken = await api.login(zhou.email);
    const room = await group(api, adminToken, '发版协作', [zhou.id, lin.id]);
    const dm = await direct(api, linToken, zhou.id);

    const sent = await api.post(`/api/conversations/${room.id}/messages`, { body: '我先发一条' }, zhouToken);
    assert.equal(sent.status, 201);
    assert.equal(sent.body.message.senderName, '周原');

    assert.equal((await api.patch('/api/auth/me', { name: '周原原' }, zhouToken)).status, 200);

    // 会话列表：群成员那一份、以及私聊标题（它就是对方的名字）
    const list = (await api.get('/api/conversations', linToken)).body.conversations;
    const roomNow = list.find((c) => c.id === room.id);
    assert.equal(roomNow.members.find((m) => m.id === zhou.id).name, '周原原');
    assert.equal(list.find((c) => c.id === dm.id).title, '周原原');

    // 历史消息：messages 表里根本没有 sender_name 这一列，取的是 JOIN users 的现值
    const page = (await api.get(`/api/conversations/${room.id}/messages`, linToken)).body;
    assert.equal(page.messages.find((m) => m.id === sent.body.message.id).senderName, '周原原');
  });

  it('引用摘要里的名字同样跟着变', async () => {
    const wu = await member('吴岸', { dept: '测试' });
    const wuToken = await api.login(wu.email);
    const room = await group(api, adminToken, '引用测试群', [wu.id, lin.id]);

    const first = await api.post(`/api/conversations/${room.id}/messages`, { body: '原始消息' }, wuToken);
    assert.equal(first.status, 201);
    const reply = await api.post(
      `/api/conversations/${room.id}/messages`,
      { body: '回一句', replyTo: first.body.message.id },
      linToken,
    );
    assert.equal(reply.body.message.quote.senderName, '吴岸');

    assert.equal((await api.patch('/api/auth/me', { name: '吴岸线' }, wuToken)).status, 200);

    const page = (await api.get(`/api/conversations/${room.id}/messages`, linToken)).body;
    assert.equal(page.messages.find((m) => m.id === reply.body.message.id).quote.senderName, '吴岸线');
  });
});
