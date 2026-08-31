// 引用回复：发消息时带上 replyTo，读消息时把被引用消息的摘要一起给出来。
// 这里最要紧的一条是跨会话引用 —— 被引用的消息必须属于同一个会话，
// 否则任何人都能拿别的群的消息 id 当 replyTo，从引用摘要里把那边的正文读走。
import { startServer } from './helpers.js';
import { direct, group, member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, db, adminToken, chen, zhou, chenToken, zhouToken, roomA, roomB, dm;

const send = (id, body, token, extra = {}) =>
  api.post(`/api/conversations/${id}/messages`, { body, ...extra }, token);
const messagesOf = async (id, token) => (await api.get(`/api/conversations/${id}/messages`, token)).body.messages;
const findMessage = async (id, token, messageId) => (await messagesOf(id, token)).find((m) => m.id === messageId);

before(async () => {
  api = await startServer();
  db = await import('../src/db.js');
  adminToken = await api.loginAdmin();
  chen = await member('陈子航', { dept: '后端' });
  zhou = await member('周明', { dept: '前端' });
  chenToken = await api.login(chen.email);
  zhouToken = await api.login(zhou.email);

  roomA = await group(api, adminToken, '引用测试 · A 群', [chen.id, zhou.id]);
  roomB = await group(api, adminToken, '引用测试 · B 群', [chen.id]);
  dm = await direct(api, chenToken, zhou.id);
});
after(async () => { await api.close(); });

describe('带引用发消息', () => {
  it('引用同会话里的消息，回读时带上发送者名字和正文摘要', async () => {
    const original = (await send(roomA.id, '联调排期改到下周二，大家注意', chenToken)).body.message;
    const res = await send(roomA.id, '收到', zhouToken, { replyTo: original.id });

    assert.equal(res.status, 201);
    assert.equal(res.body.message.replyTo, original.id);
    assert.equal(res.body.message.quote.available, true);
    assert.equal(res.body.message.quote.senderName, '陈子航');
    assert.equal(res.body.message.quote.preview, '联调排期改到下周二，大家注意');

    // 读接口也要一并给出摘要，前端不必再发一轮请求
    const fetched = await findMessage(roomA.id, adminToken, res.body.message.id);
    assert.equal(fetched.replyTo, original.id);
    assert.equal(fetched.quote.senderName, '陈子航');
    assert.equal(fetched.quote.preview, '联调排期改到下周二，大家注意');
  });

  it('不带 replyTo 时 replyTo 与 quote 都是 null', async () => {
    const res = await send(roomA.id, '普通一条', chenToken);
    assert.equal(res.body.message.replyTo, null);
    assert.equal(res.body.message.quote, null);
  });

  it('摘要会截断长正文，图片被折成 [图片]', async () => {
    const long = (await send(roomA.id, '一'.repeat(120), chenToken)).body.message;
    const quoted = (await send(roomA.id, '好', zhouToken, { replyTo: long.id })).body.message;
    assert.equal(quoted.quote.preview.length, 48, '摘要应当截断，不能把整条正文塞进来');

    const image = (await send(roomA.id, '![截图](/uploads/a.png)', chenToken)).body.message;
    const onImage = (await send(roomA.id, '看到了', zhouToken, { replyTo: image.id })).body.message;
    assert.equal(onImage.quote.preview, '[图片]');
  });

  it('一对一会话里同样可以引用', async () => {
    const original = (await send(dm.id, '晚点同步一下', chenToken)).body.message;
    const reply = (await send(dm.id, '好', zhouToken, { replyTo: original.id })).body.message;
    assert.equal(reply.quote.senderName, '陈子航');
  });
});

describe('跨会话引用被挡住', () => {
  it('引用别的会话的消息会被拒绝，且正文不会泄漏', async () => {
    const secret = (await send(roomB.id, 'B 群的机密：下周三对外发布', chenToken)).body.message;

    // 陈子航两个群都在，所以这不是「看不见那条消息」，纯粹是不允许跨会话引用
    const res = await send(roomA.id, '我引一下', chenToken, { replyTo: secret.id });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /不存在或不属于当前会话/);
    assert.ok(!JSON.stringify(res.body).includes('机密'), '错误响应里不该出现被引用消息的正文');

    // 也确实没写进库
    assert.equal(db.get('SELECT count(*) AS n FROM messages WHERE reply_to = ?', secret.id).n, 0);
  });

  it('引用我根本不在的会话里的消息，同样是 400，提示与上面完全一致', async () => {
    // 周明不在 B 群
    const inB = (await send(roomB.id, 'B 群内部讨论', chenToken)).body.message;
    const notMine = await send(roomA.id, '引一下', zhouToken, { replyTo: inB.id });
    const notExist = await send(roomA.id, '引一下', zhouToken, { replyTo: 'm_根本不存在' });

    assert.equal(notMine.status, 400);
    assert.equal(notExist.status, 400);
    assert.equal(notMine.body.error, notExist.body.error,
      '两种失败必须同一句话，否则接口就成了「这条消息是否存在」的探针');
  });

  it('就算库里被写进跨会话的 reply_to，摘要也只降级不泄漏', async () => {
    // 第二道防线：绕过接口直接改库，模拟历史脏数据或别处的 bug
    const secret = (await send(roomB.id, 'B 群的口令是 8848', chenToken)).body.message;
    const carrier = (await send(roomA.id, '我是 A 群的一条消息', chenToken)).body.message;
    db.run('UPDATE messages SET reply_to = ? WHERE id = ?', secret.id, carrier.id);

    const fetched = await findMessage(roomA.id, zhouToken, carrier.id);
    assert.equal(fetched.quote.available, false, '不同会话的原消息一律当作不可用');
    assert.equal(fetched.quote.preview, '消息已不可用');
    assert.ok(!JSON.stringify(fetched).includes('8848'), 'B 群的正文一个字都不该出现在 A 群的响应里');
  });
});

describe('被引用消息不可用时的降级', () => {
  it('原消息被删掉后显示「消息已不可用」', async () => {
    const original = (await send(roomA.id, '这条待会儿会被删掉', chenToken)).body.message;
    const reply = (await send(roomA.id, '回一下', zhouToken, { replyTo: original.id })).body.message;
    assert.equal(reply.quote.available, true);

    db.run('DELETE FROM messages WHERE id = ?', original.id);

    const fetched = await findMessage(roomA.id, zhouToken, reply.id);
    assert.equal(fetched.replyTo, original.id, 'reply_to 仍然留着，不会被悄悄置空');
    assert.equal(fetched.quote.available, false);
    assert.equal(fetched.quote.senderName, '');
    assert.equal(fetched.quote.preview, '消息已不可用');
  });

  it('发送者退群之后，引用摘要照常显示他的名字', async () => {
    const leaver = await member('要退群的人');
    const room = await group(api, adminToken, '引用测试 · 退群群', [chen.id, leaver.id]);
    const leaverToken = await api.login(leaver.email);

    const original = (await send(room.id, '我走之前说的这句话', leaverToken)).body.message;
    const reply = (await send(room.id, '记下了', chenToken, { replyTo: original.id })).body.message;

    assert.equal((await api.post(`/api/conversations/${room.id}/leave`, {}, leaverToken)).status, 200);

    const fetched = await findMessage(room.id, chenToken, reply.id);
    assert.equal(fetched.quote.available, true, '退群删的是成员关系，消息还在');
    assert.equal(fetched.quote.senderName, '要退群的人');
    assert.equal(fetched.quote.preview, '我走之前说的这句话');
  });

  it('连发送者的账号都查不到时用占位名，不会把 quote 整个弄丢', async () => {
    // users 那行不见了属于历史脏数据：外键拦着，正常路径造不出来，这里临时关掉外键来构造。
    const { quoteOf } = await import('../src/routes/conversations.js');
    const ts = Date.now();
    db.db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.run(
        `INSERT INTO messages (id, conversation_id, sender_id, body, mentions, kind, created_at)
         VALUES ('m_orphan', ?, 'u_已经没有这个人了', '孤儿消息', '[]', 'user', ?)`,
        roomA.id, ts,
      );
    } finally {
      db.db.exec('PRAGMA foreign_keys = ON');
    }

    const quote = quoteOf('m_orphan', roomA.id);
    assert.equal(quote.available, true);
    assert.equal(quote.senderName, '已注销的成员');
    assert.equal(quote.preview, '孤儿消息');
  });
});

describe('引用摘要只展开一层', () => {
  it('A 引用 B、B 引用 C 时，A 的摘要里不再嵌套 B 的引用', async () => {
    const c = (await send(roomA.id, 'C：最初那条', chenToken)).body.message;
    const b = (await send(roomA.id, 'B：回 C', zhouToken, { replyTo: c.id })).body.message;
    const a = (await send(roomA.id, 'A：回 B', chenToken, { replyTo: b.id })).body.message;

    assert.equal(a.quote.preview, 'B：回 C');
    assert.deepEqual(Object.keys(a.quote).sort(), ['available', 'preview', 'senderName']);
    assert.equal(a.quote.quote, undefined, '摘要里不能再挂一层摘要');
    assert.equal(a.quote.replyTo, undefined);
  });
});
