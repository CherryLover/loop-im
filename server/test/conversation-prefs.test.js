// 会话置顶与免打扰：都是「每个用户对每个会话」的个人偏好，存在 conversation_members
// 自己那一行上。这里盯死三件事：一个人的设置不外溢到别人、置顶只改分组不改组内顺序、
// 免打扰不动未读计数。
import { startServer } from './helpers.js';
import { direct, group, member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, adminToken, chen, zhou, chenToken, zhouToken, room, other, dm;

const conversationsOf = async (token) => (await api.get('/api/conversations', token)).body.conversations;
const findConvo = async (token, id) => (await conversationsOf(token)).find((c) => c.id === id);
const send = (id, body, token) => api.post(`/api/conversations/${id}/messages`, { body }, token);
const setPrefs = (id, prefs, token) => api.patch(`/api/conversations/${id}/prefs`, prefs, token);
const markRead = (id, token) => api.post(`/api/conversations/${id}/read`, {}, token);

before(async () => {
  api = await startServer();
  adminToken = await api.loginAdmin();
  chen = await member('陈子航', { dept: '后端' });
  zhou = await member('周明', { dept: '前端' });
  chenToken = await api.login(chen.email);
  zhouToken = await api.login(zhou.email);
  // 关掉静默读取，AI 不插话，未读条数才好数
  await api.put('/api/ai/settings', { silentRead: false, replyAtAll: false, allowDm: true }, adminToken);
  room = await group(api, adminToken, '发版协作', [chen.id, zhou.id]);
  other = await group(api, adminToken, '日常闲聊', [chen.id, zhou.id]);
  dm = await direct(api, chenToken, zhou.id);
});
after(async () => { await api.close(); });

describe('会话置顶 · 免打扰的默认值', () => {
  it('新会话默认既没置顶也没免打扰，字段名就是 pinned / muted 且是布尔', async () => {
    const convo = await findConvo(chenToken, room.id);
    assert.equal(convo.pinned, false);
    assert.equal(convo.muted, false);
  });

  it('单条会话接口也带上这两个字段', async () => {
    const res = await api.get(`/api/conversations/${room.id}`, chenToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.conversation.pinned, false);
    assert.equal(res.body.conversation.muted, false);
  });
});

describe('置顶是个人设置，不外溢', () => {
  it('陈子航置顶之后，自己看到 pinned=true', async () => {
    const res = await setPrefs(room.id, { pinned: true }, chenToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.conversation.pinned, true);
    assert.equal((await findConvo(chenToken, room.id)).pinned, true);
  });

  it('A 的置顶不影响 B —— 周明看到的同一个群仍然没被置顶', async () => {
    // 这条是本功能最容易做错的一条：一旦把 pinned 挂到 conversations 表上，
    // 陈子航一置顶，周明这边也会跟着变。
    assert.equal((await findConvo(zhouToken, room.id)).pinned, false);
    assert.equal((await findConvo(adminToken, room.id)).pinned, false);
  });

  it('周明置顶另一个群，两个人各看各的', async () => {
    await setPrefs(other.id, { pinned: true }, zhouToken);

    const forChen = await conversationsOf(chenToken);
    assert.equal(forChen.find((c) => c.id === room.id).pinned, true);
    assert.equal(forChen.find((c) => c.id === other.id).pinned, false);

    const forZhou = await conversationsOf(zhouToken);
    assert.equal(forZhou.find((c) => c.id === room.id).pinned, false);
    assert.equal(forZhou.find((c) => c.id === other.id).pinned, true);
  });

  it('取消置顶同样只动自己那一行', async () => {
    await setPrefs(other.id, { pinned: false }, zhouToken);
    assert.equal((await findConvo(zhouToken, other.id)).pinned, false);
    assert.equal((await findConvo(chenToken, room.id)).pinned, true, '别人的置顶不该被顺手清掉');
  });
});

describe('免打扰是个人设置，不外溢', () => {
  it('周明设了免打扰，陈子航那边照旧', async () => {
    const res = await setPrefs(room.id, { muted: true }, zhouToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.conversation.muted, true);
    assert.equal((await findConvo(zhouToken, room.id)).muted, true);
    assert.equal((await findConvo(chenToken, room.id)).muted, false);
  });

  it('置顶和免打扰互不干扰，可以一次改两项', async () => {
    const res = await setPrefs(dm.id, { pinned: true, muted: true }, chenToken);
    assert.equal(res.body.conversation.pinned, true);
    assert.equal(res.body.conversation.muted, true);

    await setPrefs(dm.id, { muted: false }, chenToken);
    const after = await findConvo(chenToken, dm.id);
    assert.equal(after.pinned, true, '只改 muted 不应该把 pinned 一起改掉');
    assert.equal(after.muted, false);
  });
});

describe('免打扰不等于不计未读', () => {
  it('免打扰的会话照收消息、照算未读，也照算 @我', async () => {
    // 语义就是「不打扰」：不弹通知、徽标弱化，消息和未读一条不少。
    await markRead(room.id, zhouToken);
    assert.equal((await findConvo(zhouToken, room.id)).unread, 0);

    await send(room.id, '周五要发版', chenToken);
    await send(room.id, `@${zhou.name} 你那边准备好了吗`, chenToken);

    const muted = await findConvo(zhouToken, room.id);
    assert.equal(muted.muted, true, '前提：这个会话确实是免打扰的');
    assert.equal(muted.unread, 2, '免打扰不该把未读抹掉');
    assert.equal(muted.mentionsUnread, 1, '免打扰也不该把「@我」抹掉');
  });

  it('免打扰的会话仍然能正常上报已读把未读清零', async () => {
    const res = await markRead(room.id, zhouToken);
    assert.equal(res.body.unread, 0);
    assert.equal((await findConvo(zhouToken, room.id)).unread, 0);
  });
});

describe('会话列表排序', () => {
  it('置顶的排最前，两组内部都仍按最后消息时间倒序', async () => {
    // 先把三个会话的最后消息时间拉开：闲聊最新、发版协作次之、私聊最早。
    await send(dm.id, '私聊里的一句', chenToken);
    await send(room.id, '群里的一句', chenToken);
    await send(other.id, '闲聊里的一句', chenToken);

    // 陈子航此刻：dm 置顶（上一组用例留下的），room 置顶，other 没置顶。
    await setPrefs(room.id, { pinned: true }, chenToken);
    await setPrefs(other.id, { pinned: false }, chenToken);

    const list = await conversationsOf(chenToken);
    const mine = list.filter((c) => [dm.id, room.id, other.id].includes(c.id));
    // 置顶组：room（群里的一句）比 dm（私聊里的一句）更新，所以 room 在前；
    // 非置顶组：other 虽然消息最新，但没置顶，只能排在两个置顶的后面。
    assert.deepEqual(mine.map((c) => c.id), [room.id, dm.id, other.id]);
    assert.deepEqual(mine.map((c) => c.pinned), [true, true, false]);
  });

  it('取消置顶后立刻回到按时间排的位置', async () => {
    await setPrefs(room.id, { pinned: false }, chenToken);
    await setPrefs(dm.id, { pinned: false }, chenToken);

    const list = await conversationsOf(chenToken);
    const mine = list.filter((c) => [dm.id, room.id, other.id].includes(c.id));
    assert.deepEqual(mine.map((c) => c.id), [other.id, room.id, dm.id], '全不置顶时就是纯时间倒序');
  });

  it('每个人按自己的置顶排序', async () => {
    await setPrefs(dm.id, { pinned: true }, zhouToken);
    const forZhou = (await conversationsOf(zhouToken)).filter((c) => [dm.id, room.id, other.id].includes(c.id));
    assert.equal(forZhou[0].id, dm.id, '周明置顶了私聊，他这边私聊在最前');

    const forChen = (await conversationsOf(chenToken)).filter((c) => [dm.id, room.id, other.id].includes(c.id));
    assert.equal(forChen[0].id, other.id, '陈子航没有置顶，他这边还是纯时间倒序');
  });
});

describe('接口的边界', () => {
  it('不是成员的会话改不了，报 404（和其他接口一致，不泄露会话是否存在）', async () => {
    const outsider = await member('林悦', { dept: '产品' });
    const outsiderToken = await api.login(outsider.email);
    const res = await setPrefs(room.id, { pinned: true }, outsiderToken);
    assert.equal(res.status, 404);
  });

  it('什么都不给报 400', async () => {
    const res = await setPrefs(room.id, {}, chenToken);
    assert.equal(res.status, 400);
  });

  it('非布尔值报 400，不会被当成真值悄悄写进去', async () => {
    const res = await setPrefs(room.id, { pinned: 'yes' }, chenToken);
    assert.equal(res.status, 400);
    assert.equal((await findConvo(chenToken, room.id)).pinned, false, '拒绝之后不该留下副作用');
  });

  it('未登录改不了', async () => {
    const res = await api.patch(`/api/conversations/${room.id}/prefs`, { pinned: true });
    assert.equal(res.status, 401);
  });

  it('重复设置同一个值是幂等的', async () => {
    await setPrefs(other.id, { muted: true }, chenToken);
    await setPrefs(other.id, { muted: true }, chenToken);
    assert.equal((await findConvo(chenToken, other.id)).muted, true);
  });
});
