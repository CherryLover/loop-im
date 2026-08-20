// 群成员管理：加人、移除、改群名、退群，以及各自的权限边界。
import { startServer } from './helpers.js';
import { group, member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, adminToken, chen, zhou, su, chenToken, zhouToken, suToken;

const membersOf = async (id, token) =>
  (await api.get(`/api/conversations/${id}`, token)).body.conversation.members.map((m) => m.name);
const messagesOf = async (id, token) => (await api.get(`/api/conversations/${id}/messages`, token)).body.messages;
const addMembers = (id, userIds, token) => api.post(`/api/conversations/${id}/members`, { userIds }, token);
const removeMember = (id, userId, token) => api.call('DELETE', `/api/conversations/${id}/members/${userId}`, { token });
const rename = (id, title, token) => api.patch(`/api/conversations/${id}`, { title }, token);
const leave = (id, token) => api.post(`/api/conversations/${id}/leave`, {}, token);

before(async () => {
  api = await startServer();
  adminToken = await api.loginAdmin();
  chen = await member('陈子航', { dept: '后端' });
  zhou = await member('周明', { dept: '前端' });
  su = await member('苏晴', { dept: '设计' });
  chenToken = await api.login(chen.email);
  zhouToken = await api.login(zhou.email);
  suToken = await api.login(su.email);
  await api.put('/api/ai/settings', { silentRead: false, replyAtAll: false, allowDm: true }, adminToken);
});
after(async () => { await api.close(); });

const freshGroup = (title) => group(api, adminToken, title, [chen.id]);

describe('建群人数限制放开', () => {
  it('1 个人也能建群，不再要求恰好 2–3 人', async () => {
    const room = await freshGroup('两人小组');
    assert.ok(room.id);
    assert.deepEqual((await membersOf(room.id, adminToken)).sort(), ['Aria', '测试管理员', '陈子航'].sort());
  });

  it('一个成员都不选仍然拒绝', async () => {
    const res = await api.post('/api/conversations/group', { title: '空群', memberIds: [] }, adminToken);
    assert.equal(res.status, 400);
  });

  it('超过 3 人也可以', async () => {
    const res = await api.post(
      '/api/conversations/group', { title: '大群', memberIds: [chen.id, zhou.id, su.id] }, adminToken,
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.conversation.members.length, 5);   // 管理员 + 3 人 + Aria
  });
});

describe('添加成员', () => {
  it('群主可以加人，并留下系统提示', async () => {
    const room = await freshGroup('加人测试');
    const res = await addMembers(room.id, [zhou.id, su.id], adminToken);
    assert.equal(res.status, 200);
    assert.ok((await membersOf(room.id, adminToken)).includes('周明'));
    assert.ok((await membersOf(room.id, adminToken)).includes('苏晴'));

    const last = (await messagesOf(room.id, adminToken)).at(-1);
    assert.equal(last.kind, 'system');
    assert.match(last.body, /邀请 周明、苏晴 加入了群聊/);
  });

  it('新成员随后能看到这个会话', async () => {
    const room = await freshGroup('新成员可见');
    await addMembers(room.id, [zhou.id], adminToken);
    const list = (await api.get('/api/conversations', zhouToken)).body.conversations;
    assert.ok(list.some((c) => c.id === room.id));
  });

  it('普通成员不能加人', async () => {
    const room = await freshGroup('权限测试');
    const res = await addMembers(room.id, [zhou.id], chenToken);
    assert.equal(res.status, 403);
  });

  it('重复添加已在群里的人会被拒绝', async () => {
    const room = await freshGroup('重复添加');
    assert.equal((await addMembers(room.id, [chen.id], adminToken)).status, 400);
  });

  it('添加不存在的人会被拒绝', async () => {
    const room = await freshGroup('不存在的人');
    assert.equal((await addMembers(room.id, ['u_不存在'], adminToken)).status, 400);
  });
});

describe('移除成员', () => {
  it('群主可以移除普通成员，并留下系统提示', async () => {
    const room = await freshGroup('移除测试');
    await addMembers(room.id, [zhou.id], adminToken);
    const res = await removeMember(room.id, zhou.id, adminToken);
    assert.equal(res.status, 200);
    assert.ok(!(await membersOf(room.id, adminToken)).includes('周明'));

    const last = (await messagesOf(room.id, adminToken)).at(-1);
    assert.equal(last.kind, 'system');
    assert.match(last.body, /将 周明 移出了群聊/);
  });

  it('被移除的人不再能读到这个会话', async () => {
    const room = await freshGroup('移除后失去访问');
    await addMembers(room.id, [zhou.id], adminToken);
    await removeMember(room.id, zhou.id, adminToken);
    assert.equal((await api.get(`/api/conversations/${room.id}/messages`, zhouToken)).status, 404);
  });

  it('不能移除群主', async () => {
    const room = await freshGroup('不能移除群主');
    const res = await removeMember(room.id, room.members.find((m) => m.roleInGroup === '管理员').id, adminToken);
    assert.equal(res.status, 400);
  });

  it('普通成员不能移除别人', async () => {
    const room = await freshGroup('无权移除');
    await addMembers(room.id, [zhou.id], adminToken);
    assert.equal((await removeMember(room.id, zhou.id, chenToken)).status, 403);
  });

  it('Aria 可以被移出，移出后新消息不再对 AI 可见', async () => {
    const room = await freshGroup('移出 Aria');
    await api.put('/api/ai/settings', { silentRead: true }, adminToken);

    assert.equal((await removeMember(room.id, 'ai', adminToken)).status, 200);
    assert.ok(!(await membersOf(room.id, adminToken)).includes('Aria'));

    await api.post(`/api/conversations/${room.id}/messages`, { body: '这条 Aria 不该读到' }, chenToken);
    const raw = (await messagesOf(room.id, adminToken)).at(-1);
    assert.equal(raw.body, '这条 Aria 不该读到');
    // ai_visible 是写库时定档的，Aria 不在群里就一定是 0
    const { get } = await import('../src/db.js');
    assert.equal(get('SELECT ai_visible FROM messages WHERE id = ?', raw.id).ai_visible, 0);

    await api.put('/api/ai/settings', { silentRead: false }, adminToken);
  });
});

describe('改群名', () => {
  it('群主可以改，并留下系统提示', async () => {
    const room = await freshGroup('旧名字');
    const res = await rename(room.id, '新名字', adminToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.conversation.title, '新名字');
    assert.match((await messagesOf(room.id, adminToken)).at(-1).body, /把群名改为「新名字」/);
  });

  it('空名字被拒绝', async () => {
    const room = await freshGroup('空名字');
    assert.equal((await rename(room.id, '   ', adminToken)).status, 400);
  });

  it('普通成员不能改群名', async () => {
    const room = await freshGroup('无权改名');
    assert.equal((await rename(room.id, '偷偷改掉', chenToken)).status, 403);
  });

  it('改成同样的名字不会刷出一条无意义的系统提示', async () => {
    const room = await freshGroup('同名');
    const before = (await messagesOf(room.id, adminToken)).length;
    await rename(room.id, '同名', adminToken);
    assert.equal((await messagesOf(room.id, adminToken)).length, before);
  });
});

describe('退出群聊', () => {
  it('任何成员都能自己退群，并留下系统提示', async () => {
    const room = await freshGroup('退群测试');
    await addMembers(room.id, [zhou.id], adminToken);
    assert.equal((await leave(room.id, zhouToken)).status, 200);
    assert.ok(!(await membersOf(room.id, adminToken)).includes('周明'));
    assert.match((await messagesOf(room.id, adminToken)).at(-1).body, /周明 退出了群聊/);
  });

  it('退群后就读不到这个会话了', async () => {
    const room = await freshGroup('退群后失去访问');
    await addMembers(room.id, [zhou.id], adminToken);
    await leave(room.id, zhouToken);
    assert.equal((await api.get(`/api/conversations/${room.id}/messages`, zhouToken)).status, 404);
  });

  it('私聊不能「退出」', async () => {
    const dmRes = await api.post('/api/conversations/direct', { userId: zhou.id }, chenToken);
    assert.equal((await leave(dmRes.body.conversation.id, chenToken)).status, 400);
  });

  it('不是成员的人退不了', async () => {
    const room = await freshGroup('非成员退群');
    assert.equal((await leave(room.id, suToken)).status, 404);
  });
});

describe('系统提示不进 AI 学习', () => {
  it('系统提示的 ai_visible 恒为 0', async () => {
    const room = await freshGroup('系统提示不学');
    await addMembers(room.id, [zhou.id], adminToken);
    const { all } = await import('../src/db.js');
    const rows = all("SELECT ai_visible FROM messages WHERE conversation_id = ? AND kind = 'system'", room.id);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.ai_visible === 0), '系统提示不应进入 AI 的可读范围');
  });
});
