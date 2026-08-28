// 消息表情回应：点一下 👍，再点一下取消，读消息时聚合好一起下发。
//
// 最要紧的两条：
// 1. 唯一性在库里。同一个人对同一条消息的同一个表情只能有一行——靠的是唯一索引，
//    不是「先查一下有没有再插」，后者并发点两次照样能挤进去两行。
// 2. 权限边界。只能给自己能看到的会话里的消息点回应，而且「消息不存在」和
//    「消息存在但你没权限」必须是同一句话，否则这个接口就是消息存在性探针。
import { startServer } from './helpers.js';
import { direct, group, member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, db, adminToken, chen, zhou, wu, chenToken, zhouToken, wuToken, roomA, roomB, dm;

const send = (id, body, token) => api.post(`/api/conversations/${id}/messages`, { body }, token);
const messagesOf = async (id, token) => (await api.get(`/api/conversations/${id}/messages`, token)).body.messages;
const findMessage = async (id, token, messageId) => (await messagesOf(id, token)).find((m) => m.id === messageId);

const react = (convoId, messageId, emoji, token) =>
  api.post(`/api/conversations/${convoId}/messages/${messageId}/reactions`, { emoji }, token);
const unreact = (convoId, messageId, emoji, token) =>
  api.call('DELETE', `/api/conversations/${convoId}/messages/${messageId}/reactions?emoji=${encodeURIComponent(emoji)}`, { token });

/** 库里这条消息一共有几行回应。唯一约束是否真的生效，只有直接数行才算数。 */
const rowCount = (messageId) =>
  db.get('SELECT count(*) AS n FROM message_reactions WHERE message_id = ?', messageId).n;

before(async () => {
  api = await startServer();
  db = await import('../src/db.js');
  adminToken = await api.loginAdmin();
  chen = await member('陈子航', { dept: '后端' });
  zhou = await member('周明', { dept: '前端' });
  wu = await member('吴桐', { dept: '设计' });
  chenToken = await api.login(chen.email);
  zhouToken = await api.login(zhou.email);
  wuToken = await api.login(wu.email);

  roomA = await group(api, adminToken, '回应测试 · A 群', [chen.id, zhou.id]);
  roomB = await group(api, adminToken, '回应测试 · B 群', [chen.id]);
  dm = await direct(api, chenToken, zhou.id);
});
after(async () => { await api.close(); });

describe('点一个回应', () => {
  it('点完就能在聚合里看到：表情、计数、都有谁、我点没点', async () => {
    const m = (await send(roomA.id, '发版脚本改好了', chenToken)).body.message;
    assert.deepEqual(m.reactions, [], '刚发出的消息还没有回应');

    const res = await react(roomA.id, m.id, '👍', zhouToken);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.reactions, [
      { emoji: '👍', count: 1, users: [{ id: zhou.id, name: '周明' }], mine: true },
    ]);

    // 读消息时一起带回来，前端不用再发一轮请求
    const fetched = await findMessage(roomA.id, chenToken, m.id);
    assert.equal(fetched.reactions.length, 1);
    assert.equal(fetched.reactions[0].emoji, '👍');
    assert.equal(fetched.reactions[0].count, 1);
    assert.equal(fetched.reactions[0].mine, false, '陈子航没点，mine 应当是 false');
  });

  it('多个人点同一个表情合成一条，计数累加，mine 各看各的', async () => {
    const m = (await send(roomA.id, '周会挪到周四', chenToken)).body.message;
    await react(roomA.id, m.id, '🎉', zhouToken);
    await react(roomA.id, m.id, '🎉', chenToken);

    const forZhou = (await findMessage(roomA.id, zhouToken, m.id)).reactions;
    assert.equal(forZhou.length, 1, '同一个表情只占一条聚合');
    assert.equal(forZhou[0].count, 2);
    assert.deepEqual(forZhou[0].users.map((u) => u.name), ['周明', '陈子航'], '按点的先后排');
    assert.equal(forZhou[0].mine, true);

    const forAdmin = (await findMessage(roomA.id, adminToken, m.id)).reactions;
    assert.equal(forAdmin[0].mine, false, '管理员没点，同一条聚合对他 mine 是 false');
  });

  it('不同表情各占一条，按最早点的先后排', async () => {
    const m = (await send(roomA.id, '灰度已经全量', chenToken)).body.message;
    await react(roomA.id, m.id, '🎉', zhouToken);
    await react(roomA.id, m.id, '👍', chenToken);

    const list = (await findMessage(roomA.id, zhouToken, m.id)).reactions;
    assert.deepEqual(list.map((r) => r.emoji), ['🎉', '👍']);
  });

  it('自己发的消息也能自己回应', async () => {
    const m = (await send(dm.id, '我先撤了', chenToken)).body.message;
    const res = await react(dm.id, m.id, '😄', chenToken);
    assert.equal(res.body.reactions[0].mine, true);
  });
});

describe('唯一约束', () => {
  it('同一个人重复点同一个表情，库里始终只有一行', async () => {
    const m = (await send(roomA.id, '重复点这条', chenToken)).body.message;
    for (let i = 0; i < 3; i += 1) assert.equal((await react(roomA.id, m.id, '👍', zhouToken)).status, 200);

    assert.equal(rowCount(m.id), 1, '点三次也只能有一行');
    const list = (await findMessage(roomA.id, zhouToken, m.id)).reactions;
    assert.equal(list[0].count, 1);
    assert.equal(list[0].users.length, 1);
  });

  it('约束在库里，绕过接口直接插也插不进第二行', async () => {
    const m = (await send(roomA.id, '直接写库这条', chenToken)).body.message;
    await react(roomA.id, m.id, '❤️', zhouToken);

    assert.throws(
      () => db.run(
        'INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
        m.id, zhou.id, '❤️', Date.now(),
      ),
      /UNIQUE|constraint/i,
      '唯一约束必须是库级别的，光靠应用层判断挡不住并发',
    );
    assert.equal(rowCount(m.id), 1);
  });

  it('换个人、换个表情、换条消息都不受这条约束影响', async () => {
    const m = (await send(roomA.id, '各点各的', chenToken)).body.message;
    await react(roomA.id, m.id, '👍', zhouToken);
    await react(roomA.id, m.id, '👍', chenToken);       // 换人
    await react(roomA.id, m.id, '🙏', zhouToken);       // 换表情
    assert.equal(rowCount(m.id), 3);
  });
});

describe('取消回应', () => {
  it('再点一次就没了，行也跟着删掉', async () => {
    const m = (await send(roomA.id, '取消这条', chenToken)).body.message;
    await react(roomA.id, m.id, '👍', zhouToken);
    assert.equal(rowCount(m.id), 1);

    const res = await unreact(roomA.id, m.id, '👍', zhouToken);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.reactions, []);
    assert.equal(rowCount(m.id), 0);
  });

  it('只取消自己那一个，别人的和自己别的表情都留着', async () => {
    const m = (await send(roomA.id, '只撤自己的', chenToken)).body.message;
    await react(roomA.id, m.id, '👍', zhouToken);
    await react(roomA.id, m.id, '👍', chenToken);
    await react(roomA.id, m.id, '🎉', zhouToken);

    await unreact(roomA.id, m.id, '👍', zhouToken);
    const list = (await findMessage(roomA.id, zhouToken, m.id)).reactions;
    assert.deepEqual(list.map((r) => [r.emoji, r.count, r.mine]), [['👍', 1, false], ['🎉', 1, true]]);
  });

  it('没点过也能调取消，不报错，也不动别人的', async () => {
    const m = (await send(roomA.id, '没点过就取消', chenToken)).body.message;
    await react(roomA.id, m.id, '👍', chenToken);

    const res = await unreact(roomA.id, m.id, '👍', zhouToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.reactions[0].count, 1, '陈子航那一个还在');
    assert.equal(res.body.reactions[0].mine, false);
  });
});

describe('表情白名单', () => {
  const REJECTED = [
    ['一整段文本', '这不是表情，这是一句话'],
    ['HTML', '<img src=x onerror=alert(1)>'],
    ['空串', ''],
    ['空格', ' '],
    ['不在白名单里的表情', '💩'],
    ['超长串', '👍'.repeat(500)],
    ['数字', 12345],
    ['数组', ['👍']],
    ['对象', { emoji: '👍' }],
    ['null', null],
  ];

  for (const [label, value] of REJECTED) {
    it(`${label}会被拒绝，且一行都不会落库`, async () => {
      const m = (await send(roomA.id, `白名单 · ${label}`, chenToken)).body.message;
      const res = await api.post(`/api/conversations/${roomA.id}/messages/${m.id}/reactions`, { emoji: value }, zhouToken);

      assert.equal(res.status, 400, `${label} 不该被接受`);
      assert.equal(res.body.error, '不支持的表情');
      assert.equal(rowCount(m.id), 0, `${label} 不该落库`);
    });
  }

  it('白名单里的每一个都能点', async () => {
    const { REACTION_EMOJIS } = await import('../src/reactions.js');
    const m = (await send(roomA.id, '白名单全点一遍', chenToken)).body.message;
    for (const emoji of REACTION_EMOJIS) {
      assert.equal((await react(roomA.id, m.id, emoji, zhouToken)).status, 200, `${emoji} 应当被接受`);
    }
    assert.equal(rowCount(m.id), REACTION_EMOJIS.length);
  });

  it('多字节表情原样存回，不会被按字节截断', async () => {
    const m = (await send(roomA.id, '多字节这条', chenToken)).body.message;
    await react(roomA.id, m.id, '🎉', zhouToken);
    const stored = db.get('SELECT emoji FROM message_reactions WHERE message_id = ?', m.id).emoji;
    assert.equal(stored, '🎉');
    assert.equal([...stored].length, 1, '存回来仍然是一个完整的码位，不是半个代理对');
  });

  it('带不带变体选择符都算同一个表情，不会排成两个计数', async () => {
    const m = (await send(roomA.id, '变体选择符这条', chenToken)).body.message;
    await react(roomA.id, m.id, '❤️', zhouToken);   // ❤️
    await react(roomA.id, m.id, '❤', zhouToken);         // ❤（没有 U+FE0F）

    assert.equal(rowCount(m.id), 1, '归一之后是同一行');
    const list = (await findMessage(roomA.id, zhouToken, m.id)).reactions;
    assert.equal(list.length, 1);
    assert.equal(list[0].emoji, '❤️', '一律按白名单里的写法落库');

    // 取消时同样归一：用没有变体选择符的写法也能撤掉
    await unreact(roomA.id, m.id, '❤', zhouToken);
    assert.equal(rowCount(m.id), 0);
  });

  it('查询串里传两个 emoji 参数（解析成数组）同样被拒绝', async () => {
    const m = (await send(roomA.id, '重复参数这条', chenToken)).body.message;
    await react(roomA.id, m.id, '👍', zhouToken);
    const res = await api.call('DELETE',
      `/api/conversations/${roomA.id}/messages/${m.id}/reactions?emoji=%F0%9F%91%8D&emoji=%F0%9F%8E%89`, { token: zhouToken });
    assert.equal(res.status, 400);
    assert.equal(rowCount(m.id), 1, '什么都不该被删掉');
  });
});

describe('权限边界', () => {
  it('不在那个会话里的人点不了，提示与「消息不存在」完全一致', async () => {
    // 吴桐哪个群都不在
    const secret = (await send(roomB.id, 'B 群的机密：下周三对外发布', chenToken)).body.message;

    const notMine = await react(roomB.id, secret.id, '👍', wuToken);
    const notExist = await react(roomB.id, 'm_根本不存在', '👍', wuToken);

    assert.equal(notMine.status, 404);
    assert.equal(notExist.status, 404);
    assert.equal(notMine.body.error, notExist.body.error,
      '两种失败必须同一句话，否则接口就成了「这条消息是否存在」的探针');
    assert.ok(!JSON.stringify(notMine.body).includes('机密'), '错误响应里不该出现消息正文');
    assert.equal(rowCount(secret.id), 0);
  });

  it('拿别的会话的消息 id 挂到自己在的会话上，同样是这一句', async () => {
    // 周明在 A 群、不在 B 群；他知道 B 群某条消息的 id 也没用
    const inB = (await send(roomB.id, 'B 群内部讨论', chenToken)).body.message;

    const crossed = await react(roomA.id, inB.id, '👍', zhouToken);
    const missing = await react(roomA.id, 'm_也不存在', '👍', zhouToken);

    assert.equal(crossed.status, 404);
    assert.equal(crossed.body.error, missing.body.error);
    assert.equal(rowCount(inB.id), 0);
  });

  it('两个群都在的人，也不能跨会话给消息点回应', async () => {
    // 陈子航 A、B 两个群都在，这不是「看不见那条消息」，纯粹是不允许跨会话
    const inB = (await send(roomB.id, 'B 群的另一条', chenToken)).body.message;
    const res = await react(roomA.id, inB.id, '👍', chenToken);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, '消息不存在或无权访问');

    // 换成正确的会话 id 就能点，说明挡住的确实是「跨会话」这一件事
    assert.equal((await react(roomB.id, inB.id, '👍', chenToken)).status, 200);
  });

  it('取消接口的两种失败提示同样一致', async () => {
    const inB = (await send(roomB.id, '再来一条', chenToken)).body.message;
    const notMine = await unreact(roomB.id, inB.id, '👍', wuToken);
    const notExist = await unreact(roomB.id, 'm_仍然不存在', '👍', wuToken);

    assert.equal(notMine.status, 404);
    assert.equal(notExist.status, 404);
    assert.equal(notMine.body.error, notExist.body.error);
  });

  it('没登录一律 401', async () => {
    const m = (await send(roomA.id, '未登录这条', chenToken)).body.message;
    assert.equal((await api.post(`/api/conversations/${roomA.id}/messages/${m.id}/reactions`, { emoji: '👍' })).status, 401);
  });

  it('退群之后就点不了这个群里的消息了', async () => {
    const room = await group(api, adminToken, '回应测试 · 退群群', [chen.id, wu.id]);
    const m = (await send(room.id, '我走之前的一条', chenToken)).body.message;
    assert.equal((await react(room.id, m.id, '👍', wuToken)).status, 200);

    assert.equal((await api.post(`/api/conversations/${room.id}/leave`, {}, wuToken)).status, 200);
    const afterLeave = await react(room.id, m.id, '🎉', wuToken);
    assert.equal(afterLeave.status, 404);
    assert.equal(afterLeave.body.error, '消息不存在或无权访问');
  });
});

describe('消息删掉之后不留孤儿', () => {
  it('删消息时回应跟着删（外键级联），不会留下孤儿行', async () => {
    const m = (await send(roomA.id, '这条待会儿会被删掉', chenToken)).body.message;
    await react(roomA.id, m.id, '👍', zhouToken);
    await react(roomA.id, m.id, '🎉', chenToken);
    assert.equal(rowCount(m.id), 2);

    db.run('DELETE FROM messages WHERE id = ?', m.id);
    assert.equal(rowCount(m.id), 0, '回应必须跟着消息一起消失');
  });

  it('删整个会话时，会话里消息的回应也一起清掉', async () => {
    const room = await group(api, adminToken, '回应测试 · 待删群', [chen.id]);
    const m = (await send(room.id, '连着会话一起删', chenToken)).body.message;
    await react(room.id, m.id, '👍', chenToken);
    assert.equal(rowCount(m.id), 1);

    db.run('DELETE FROM conversations WHERE id = ?', room.id);
    assert.equal(rowCount(m.id), 0);
  });
});

describe('聚合不是 N+1', () => {
  it('一页里每条消息都有回应，也只查一次 message_reactions', async () => {
    const room = await group(api, adminToken, '回应测试 · 聚合群', [chen.id, zhou.id]);
    const ids = [];
    for (let i = 0; i < 12; i += 1) {
      const m = (await send(room.id, `聚合用第 ${i} 条`, chenToken)).body.message;
      ids.push(m.id);
      await react(room.id, m.id, '👍', zhouToken);
      await react(room.id, m.id, '🎉', chenToken);
    }

    // 数一下这次读消息一共对 message_reactions 发了几条 SQL。改成逐条查的话这里会是 12。
    const original = db.db.prepare;
    const seen = [];
    db.db.prepare = function counted(sql) {
      if (/message_reactions/.test(sql)) seen.push(sql);
      return original.call(this, sql);
    };
    let page;
    try {
      page = await messagesOf(room.id, zhouToken);
    } finally {
      delete db.db.prepare;
    }
    assert.equal(db.db.prepare, original, '计数用的桩要还回去');

    assert.equal(seen.length, 1, `一页消息只该查一次回应，实际查了 ${seen.length} 次`);
    assert.match(seen[0], / IN \(/, '批量查询应当是一条 IN 查询');

    // 顺带确认聚合结果是对的，不是「查得少但查漏了」
    const withReactions = page.filter((m) => ids.includes(m.id));
    assert.equal(withReactions.length, 12);
    for (const m of withReactions) {
      assert.deepEqual(m.reactions.map((r) => [r.emoji, r.count, r.mine]), [['👍', 1, true], ['🎉', 1, false]]);
    }
  });

  it('整页都没有回应时，聚合也不多发查询、结果一律是空数组', async () => {
    const room = await group(api, adminToken, '回应测试 · 空聚合群', [chen.id]);
    for (let i = 0; i < 3; i += 1) await send(room.id, `没人回应的第 ${i} 条`, chenToken);

    const page = await messagesOf(room.id, chenToken);
    assert.ok(page.length >= 3);
    for (const m of page) assert.deepEqual(m.reactions, []);
  });
});
