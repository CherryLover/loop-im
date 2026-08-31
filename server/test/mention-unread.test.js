// 「有人 @ 我」的未读计数：会话列表除了 unread，还要给出未读里有多少条 @ 到我。
// 判定口径：在我的已读位置之后、不是我自己发的、mentions 里含我的 id 或 'all'。
import { startServer } from './helpers.js';
import { direct, group, member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, adminToken, db, mentionUnreadCount;
let chen, zhou, chenToken, zhouToken, adminId, room, dm;

const conversationsOf = async (token) => (await api.get('/api/conversations', token)).body.conversations;
const findConvo = async (token, id) => (await conversationsOf(token)).find((c) => c.id === id);
const send = (id, body, token) => api.post(`/api/conversations/${id}/messages`, { body }, token);
const markRead = (id, token) => api.post(`/api/conversations/${id}/read`, {}, token);

before(async () => {
  api = await startServer();
  adminToken = await api.loginAdmin();
  db = await import('../src/db.js');
  ({ mentionUnreadCount } = await import('../src/routes/conversations.js'));

  chen = await member('陈子航', { dept: '后端' });
  zhou = await member('周明', { dept: '前端' });
  chenToken = await api.login(chen.email);
  zhouToken = await api.login(zhou.email);
  adminId = db.get('SELECT id FROM users WHERE lower(email) = ?', process.env.ADMIN_EMAIL.toLowerCase()).id;

  room = await group(api, adminToken, '提及未读测试群', [chen.id, zhou.id]);
  dm = await direct(api, chenToken, zhou.id);
});
after(async () => { await api.close(); });

describe('@ 我的未读计数', () => {
  it('普通未读不算被 @，被 @ 的那条才算', async () => {
    await markRead(room.id, zhouToken);
    await send(room.id, '周五要发版', chenToken);

    let forZhou = await findConvo(zhouToken, room.id);
    assert.equal(forZhou.unread, 1);
    assert.equal(forZhou.mentionsUnread, 0, '没 @ 到我就不该进这一档');

    await send(room.id, `@${zhou.name} 你那块联调好了吗`, chenToken);
    forZhou = await findConvo(zhouToken, room.id);
    assert.equal(forZhou.unread, 2, '@ 我的消息同样是未读');
    assert.equal(forZhou.mentionsUnread, 1);
  });

  it('@全员 也算被 @，但自己发的 @全员 不算自己被 @', async () => {
    await markRead(room.id, zhouToken);
    await markRead(room.id, chenToken);
    await markRead(room.id, adminToken);

    await send(room.id, '@全员 站会推迟到十点', chenToken);

    assert.equal((await findConvo(zhouToken, room.id)).mentionsUnread, 1, '@全员 应当计入其他人');
    assert.equal((await findConvo(adminToken, room.id)).mentionsUnread, 1);

    const forChen = await findConvo(chenToken, room.id);
    assert.equal(forChen.unread, 0, '自己发的不算自己的未读');
    assert.equal(forChen.mentionsUnread, 0, '自己 @全员 不等于自己被 @');
  });

  it('自己 @ 自己也不算被 @', async () => {
    await markRead(room.id, chenToken);
    await send(room.id, `@${chen.name} 提醒自己一下`, chenToken);
    assert.equal((await findConvo(chenToken, room.id)).mentionsUnread, 0);
  });

  it('上报已读后两个计数一起归零', async () => {
    await send(room.id, `@${zhou.name} 顺手看下这个`, chenToken);
    assert.ok((await findConvo(zhouToken, room.id)).mentionsUnread > 0);

    await markRead(room.id, zhouToken);
    const after = await findConvo(zhouToken, room.id);
    assert.equal(after.unread, 0);
    assert.equal(after.mentionsUnread, 0, '已读之后不该再提醒有人 @ 我');
  });

  it('已读之后新来的 @ 重新计入', async () => {
    await send(room.id, `@${zhou.name} 又来一条`, chenToken);
    assert.equal((await findConvo(zhouToken, room.id)).mentionsUnread, 1);
  });

  it('一对一会话里 @ 到我同样能数出来', async () => {
    await markRead(dm.id, zhouToken);
    await send(dm.id, `@${zhou.name} 在吗`, chenToken);
    const forZhou = await findConvo(zhouToken, dm.id);
    assert.equal(forZhou.unread, 1);
    assert.equal(forZhou.mentionsUnread, 1);
  });

  it('每个会话各算各的，互不串味', async () => {
    await markRead(room.id, zhouToken);
    const list = await conversationsOf(zhouToken);
    assert.equal(list.find((c) => c.id === room.id).mentionsUnread, 0);
    assert.ok(list.find((c) => c.id === dm.id).mentionsUnread > 0);
  });
});

// mentions 是 TEXT 存的 JSON 数组，SQL 里只能做文本匹配。id 互为前缀（u_1 / u_12）
// 是这里最容易踩的坑：用真实账号跑不出来（uid() 生成的 id 不会互为前缀），
// 所以直接造一组这样的数据，验证 SQL 的判定口径本身。
describe('@ 我的未读计数 · id 互为前缀不误算', () => {
  const seed = () => {
    const ts = Date.now();
    for (const id of ['u_1', 'u_12', 'u_120', 'uX1']) {
      db.run(
        `INSERT INTO users (id, name, email, dept, role, password_hash, last_seen_at, created_at)
         VALUES (?, ?, ?, '测试', 'member', 'x', 0, ?)`,
        id, `前缀${id}`, `${id}@prefix.local`, ts,
      );
    }
    db.run('INSERT INTO conversations (id, type, title, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      'c_prefix', 'group', '前缀测试群', 'u_1', ts);
    for (const id of ['u_1', 'u_12', 'u_120', 'uX1']) {
      db.run('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)',
        'c_prefix', id, ts);
    }
    const msg = (id, sender, mentions) =>
      db.run(
        `INSERT INTO messages (id, conversation_id, sender_id, body, mentions, kind, created_at)
         VALUES (?, 'c_prefix', ?, '正文', ?, 'user', ?)`,
        id, sender, JSON.stringify(mentions), ts,
      );
    msg('m_p1', 'u_12', ['u_12']);          // 只 @ 了 u_12
    msg('m_p2', 'u_12', ['u_120']);         // 只 @ 了 u_120
    msg('m_p3', 'u_12', ['u_1', 'u_120']);  // 同时 @ 了 u_1 和 u_120
  };

  before(seed);

  it('@u_12 不会被算成 @u_1', () => {
    // u_1 只在 m_p3 里真的被 @ 到；m_p1（["u_12"]）、m_p2（["u_120"]）都含 "u_1" 这段文本。
    assert.equal(mentionUnreadCount('c_prefix', 'u_1'), 1);
  });

  it('@u_1 不会被算成 @u_12 或 @u_120', () => {
    // u_12 是 m_p1 的发送者，自己发的不算；剩下两条都没 @ 他。
    assert.equal(mentionUnreadCount('c_prefix', 'u_12'), 0);
    assert.equal(mentionUnreadCount('c_prefix', 'u_120'), 2, 'm_p2 与 m_p3 都 @ 到了 u_120');
  });

  it('id 里的下划线不当 LIKE 通配符用', () => {
    // 不转义时 "u_1" 这个 LIKE 模式会把 ["uX1"] 也匹配上。
    db.run(
      `INSERT INTO messages (id, conversation_id, sender_id, body, mentions, kind, created_at)
       VALUES ('m_p4', 'c_prefix', 'u_12', '正文', ?, 'user', ?)`,
      JSON.stringify(['uX1']), Date.now(),
    );
    assert.equal(mentionUnreadCount('c_prefix', 'u_1'), 1, '@uX1 不该算到 u_1 头上');
    assert.equal(mentionUnreadCount('c_prefix', 'uX1'), 1);
  });

  it('@全员 计入每个人，唯独不计发送者自己', () => {
    db.run(
      `INSERT INTO messages (id, conversation_id, sender_id, body, mentions, kind, created_at)
       VALUES ('m_p5', 'c_prefix', 'u_12', '正文', ?, 'user', ?)`,
      JSON.stringify(['all']), Date.now(),
    );
    assert.equal(mentionUnreadCount('c_prefix', 'u_1'), 2);
    assert.equal(mentionUnreadCount('c_prefix', 'uX1'), 2);
    assert.equal(mentionUnreadCount('c_prefix', 'u_12'), 0, '自己发的 @全员 不算自己被 @');
  });
});
