// 未读计数与已读回执：共用 conversation_reads 里的「读到哪一刻」。
import { startServer } from './helpers.js';
import { direct, group, member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, adminToken, chen, zhou, chenToken, zhouToken, room, dm;

const conversationsOf = async (token) => (await api.get('/api/conversations', token)).body.conversations;
const findConvo = async (token, id) => (await conversationsOf(token)).find((c) => c.id === id);
const send = (id, body, token) => api.post(`/api/conversations/${id}/messages`, { body }, token);
const markRead = (id, token, upTo) => api.post(`/api/conversations/${id}/read`, upTo ? { upTo } : {}, token);

before(async () => {
  api = await startServer();
  adminToken = await api.loginAdmin();
  chen = await member('陈子航', { dept: '后端' });
  zhou = await member('周明', { dept: '前端' });
  chenToken = await api.login(chen.email);
  zhouToken = await api.login(zhou.email);
  room = await group(api, adminToken, '未读测试群', [chen.id, zhou.id]);
  dm = await direct(api, chenToken, zhou.id);
});
after(async () => { await api.close(); });

describe('未读计数', () => {
  it('别人发的消息计入未读，自己发的不计', async () => {
    await send(dm, '第一条', chenToken).then(() => {});
    const conv = dm;
    await send(conv.id, '你在吗', chenToken);
    await send(conv.id, '在的话回我一下', chenToken);

    const forZhou = await findConvo(zhouToken, conv.id);
    assert.equal(forZhou.unread, 2, '收到两条应当是 2 条未读');

    const forChen = await findConvo(chenToken, conv.id);
    assert.equal(forChen.unread, 0, '自己发的不应该算自己的未读');
  });

  it('上报已读后未读归零', async () => {
    const res = await markRead(dm.id, zhouToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.unread, 0);
    assert.ok(res.body.lastReadAt > 0);

    assert.equal((await findConvo(zhouToken, dm.id)).unread, 0);
    // 对方的未读不受影响
    assert.equal((await findConvo(chenToken, dm.id)).unread, 0);
  });

  it('已读之后再来的消息重新计入未读', async () => {
    await send(dm.id, '刚想起来还有件事', chenToken);
    assert.equal((await findConvo(zhouToken, dm.id)).unread, 1);
  });

  it('群聊里每个人的未读各算各的', async () => {
    await markRead(room.id, chenToken);
    await markRead(room.id, zhouToken);
    await markRead(room.id, adminToken);

    await send(room.id, '周五要发版', chenToken);

    assert.equal((await findConvo(chenToken, room.id)).unread, 0, '发送者自己没有未读');
    assert.equal((await findConvo(zhouToken, room.id)).unread, 1);
    assert.equal((await findConvo(adminToken, room.id)).unread, 1);

    await markRead(room.id, zhouToken);
    assert.equal((await findConvo(zhouToken, room.id)).unread, 0);
    assert.equal((await findConvo(adminToken, room.id)).unread, 1, '一个人读了不影响另一个人');
  });
});

describe('已读位置', () => {
  it('只能前进，不能往回拨', async () => {
    const first = await markRead(room.id, zhouToken);
    const rewound = await markRead(room.id, zhouToken, 1000);
    assert.equal(rewound.body.lastReadAt, first.body.lastReadAt, '传一个更早的时间不应把已读位置往回拨');
  });

  it('不能把未来的消息预先标成已读', async () => {
    const future = Date.now() + 60 * 60 * 1000;
    const res = await markRead(room.id, zhouToken, future);
    assert.ok(res.body.lastReadAt <= Date.now() + 1000, '已读位置不应被推到未来');

    // 之后来的新消息照常计入未读
    await send(room.id, '这条是后来发的', chenToken);
    assert.equal((await findConvo(zhouToken, room.id)).unread, 1);
  });

  it('消息接口一并返回其他人的已读位置，且不含自己与 AI', async () => {
    await markRead(room.id, zhouToken);
    const res = await api.get(`/api/conversations/${room.id}/messages`, chenToken);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.reads));

    const ids = res.body.reads.map((r) => r.userId);
    assert.ok(ids.includes(zhou.id), '应当包含读过的其他成员');
    assert.ok(!ids.includes(chen.id), '不应包含自己');
    assert.ok(!ids.includes('ai'), 'AI 不参与已读统计');

    const zhouRead = res.body.reads.find((r) => r.userId === zhou.id);
    assert.ok(zhouRead.lastReadAt > 0);
  });

  it('不是会话成员不能上报已读', async () => {
    const outsider = await member('局外人');
    const token = await api.login(outsider.email);
    assert.equal((await markRead(room.id, token)).status, 404);
  });

  it('没有已读记录的人未读数等于全部他人消息', async () => {
    const newbie = await member('新来的');
    const token = await api.login(newbie.email);
    const fresh = await direct(api, chenToken, newbie.id);
    await send(fresh.id, '欢迎加入', chenToken);
    await send(fresh.id, '有问题随时问', chenToken);
    assert.equal((await findConvo(token, fresh.id)).unread, 2);
  });
});
