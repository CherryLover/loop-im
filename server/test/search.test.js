// 消息搜索：权限边界（搜不到自己不在的会话）、LIKE 通配符转义、游标翻页、边界关键词。
import { startServer } from './helpers.js';
import { direct, group, member } from './fixtures.js';
import { after, before as beforeAll, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, likeContains, adminToken;
let chen, chenToken, zhou, zhouToken, outsider, outsiderToken;
let ours, theirs, dm;

const search = (token, query) => api.get(`/api/messages/search?${query}`, token);
const q = (text) => `q=${encodeURIComponent(text)}`;
const bodies = (res) => res.body.results.map((r) => r.body);

/** 直接把正文写进库，绕开 @ 解析与 Aria 的后台回合，让用例只考察检索本身。 */
const say = async (conversationId, token, body) => {
  const res = await api.post(`/api/conversations/${conversationId}/messages`, { body }, token);
  assert.equal(res.status, 201, `发送失败：${JSON.stringify(res.body)}`);
  return res.body.message;
};

beforeAll(async () => {
  api = await startServer();
  ({ likeContains } = await import('../src/routes/search.js'));
  adminToken = await api.loginAdmin();
  // 关掉静默读取与 @全员 回复，免得 Aria 插话把结果条数搅乱。
  await api.put('/api/ai/settings', { silentRead: false, replyAtAll: false, allowDm: true }, adminToken);

  chen = await member('陈子航', { dept: '后端' });
  zhou = await member('周明', { dept: '前端' });
  outsider = await member('局外人', { dept: '行政' });
  chenToken = await api.login(chen.email);
  zhouToken = await api.login(zhou.email);
  outsiderToken = await api.login(outsider.email);

  ours = await group(api, adminToken, '发版协作', [chen.id, zhou.id]);
  theirs = await group(api, adminToken, '管理层同步', [outsider.id]);
  dm = await direct(api, chenToken, zhou.id);

  await say(ours.id, chenToken, '接口联调今晚能完成');
  await say(ours.id, zhouToken, '联调环境已经准备好了');
  await say(theirs.id, adminToken, '联调预算这块先不对外说');
  await say(dm.id, chenToken, '私聊里也提一句联调');
});
after(async () => { await api.close(); });

// ---- 权限边界 -----------------------------------------------------------

describe('消息搜索 · 只搜得到自己是成员的会话', () => {
  it('搜不到自己不在的群里的消息', async () => {
    const res = await search(chenToken, q('联调'));
    assert.equal(res.status, 200);
    assert.ok(bodies(res).length > 0, '自己群里的消息应当搜得到');
    assert.ok(
      !bodies(res).some((b) => b.includes('预算')),
      `不是成员的「管理层同步」不该出现在结果里：${JSON.stringify(bodies(res))}`,
    );
    for (const r of res.body.results) {
      assert.notEqual(r.conversationId, theirs.id, '不该返回任何来自非成员会话的消息');
    }
  });

  it('局外人搜同一个关键词，只看得到自己那个群', async () => {
    const res = await search(outsiderToken, q('联调'));
    assert.equal(res.status, 200);
    assert.deepEqual(bodies(res), ['联调预算这块先不对外说']);
  });

  it('退群之后就搜不到这个群的历史了', async () => {
    const room = await group(api, adminToken, '临时群', [chen.id]);
    await say(room.id, adminToken, '临时群里的秘密关键词 蒲公英');
    assert.equal((await search(chenToken, q('蒲公英'))).body.results.length, 1);

    assert.equal((await api.post(`/api/conversations/${room.id}/leave`, {}, chenToken)).status, 200);
    assert.deepEqual((await search(chenToken, q('蒲公英'))).body.results, [], '退群后不该再搜到');
  });

  it('未登录不能搜索', async () => {
    assert.equal((await search(undefined, q('联调'))).status, 401);
  });
});

describe('消息搜索 · 限定会话', () => {
  it('conversationId 只返回该会话里的消息', async () => {
    const res = await search(chenToken, `${q('联调')}&conversationId=${ours.id}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.results.length >= 2);
    for (const r of res.body.results) assert.equal(r.conversationId, ours.id);
  });

  it('限定一个自己不在的会话时按「会话不存在」处理，不泄露它的存在', async () => {
    const res = await search(chenToken, `${q('联调')}&conversationId=${theirs.id}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, '会话不存在');
  });

  it('限定一个根本不存在的会话同样是 404', async () => {
    assert.equal((await search(chenToken, `${q('联调')}&conversationId=c_不存在`)).status, 404);
  });
});

// ---- LIKE 通配符转义（用真实 SQLite 验证）--------------------------------

describe('消息搜索 · LIKE 通配符转义', () => {
  it('_ 只当普通字符：搜 a_b 不该命中 aXb', async () => {
    const room = await group(api, adminToken, '转义下划线', [chen.id]);
    await say(room.id, adminToken, '字段名是 a_b 请对齐');
    await say(room.id, adminToken, '字段名是 aXb 请对齐');

    const res = await search(chenToken, `${q('a_b')}&conversationId=${room.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(bodies(res), ['字段名是 a_b 请对齐'], '不转义时 _ 会把 aXb 一起匹配进来');
  });

  it('% 只当普通字符：搜 100%完成 不该命中 100abc完成', async () => {
    const room = await group(api, adminToken, '转义百分号', [chen.id]);
    await say(room.id, adminToken, '进度 100%完成 收工');
    await say(room.id, adminToken, '进度 100abc完成 收工');

    const res = await search(chenToken, `${q('100%完成')}&conversationId=${room.id}`);
    assert.deepEqual(bodies(res), ['进度 100%完成 收工']);
  });

  it('反斜杠自己也被转义：搜 \\% 只命中真的写了 \\% 的那条', async () => {
    const room = await group(api, adminToken, '转义反斜杠', [chen.id]);
    await say(room.id, adminToken, '正则里写成 \\% 才对');
    await say(room.id, adminToken, '正则里写成 XY 才对');

    const res = await search(chenToken, `${q('\\%')}&conversationId=${room.id}`);
    assert.deepEqual(bodies(res), ['正则里写成 \\% 才对']);
  });

  it('用户 id 形态的关键词（u_1）不会被下划线放大匹配', async () => {
    const room = await group(api, adminToken, '转义用户id', [chen.id]);
    await say(room.id, adminToken, '负责人 u_1 已确认');
    await say(room.id, adminToken, '负责人 uX1 已确认');

    const res = await search(chenToken, `${q('u_1')}&conversationId=${room.id}`);
    assert.deepEqual(bodies(res), ['负责人 u_1 已确认']);
  });

  it('likeContains 给三个特殊字符都加了反斜杠前缀', () => {
    assert.equal(likeContains('a_b'), '%a\\_b%');
    assert.equal(likeContains('100%'), '%100\\%%');
    assert.equal(likeContains('a\\b'), '%a\\\\b%');
    assert.equal(likeContains('普通'), '%普通%');
  });
});

// ---- 关键词的边界情况 ---------------------------------------------------

describe('消息搜索 · 关键词边界', () => {
  it('空关键词与纯空格都是 400，而不是把整库倒出来', async () => {
    assert.equal((await search(chenToken, 'q=')).status, 400);
    assert.equal((await search(chenToken, q('   '))).status, 400);
    assert.equal((await search(chenToken, '')).status, 400, '完全不传 q 也是 400');
  });

  it('超长关键词被拒绝', async () => {
    const { MAX_QUERY_LENGTH } = await import('../src/routes/search.js');
    assert.equal((await search(chenToken, q('联'.repeat(MAX_QUERY_LENGTH)))).status, 200, '正好到上限应当放行');
    const res = await search(chenToken, q('联'.repeat(MAX_QUERY_LENGTH + 1)));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /关键词/);
  });

  it('只有 % 的关键词按字面量搜，不是「匹配所有消息」', async () => {
    const room = await group(api, adminToken, '只有百分号', [chen.id]);
    await say(room.id, adminToken, '完成度 50% 左右');
    await say(room.id, adminToken, '完全没有特殊符号的一条');

    const res = await search(chenToken, `${q('%')}&conversationId=${room.id}`);
    assert.deepEqual(bodies(res), ['完成度 50% 左右']);
  });

  it('只有 _ 的关键词同样按字面量搜', async () => {
    const room = await group(api, adminToken, '只有下划线', [chen.id]);
    await say(room.id, adminToken, '表名 order_item');
    await say(room.id, adminToken, '表名 orderitem');

    const res = await search(chenToken, `${q('_')}&conversationId=${room.id}`);
    assert.deepEqual(bodies(res), ['表名 order_item']);
  });

  it('关键词首尾空格会被裁掉，不影响命中', async () => {
    const res = await search(chenToken, `${q('  联调  ')}&conversationId=${ours.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.query, '联调');
    assert.ok(res.body.results.length >= 2);
  });

  it('搜不到东西时返回空列表而不是报错', async () => {
    const res = await search(chenToken, q('绝不可能出现的关键词妲己麒麟'));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.results, []);
    assert.equal(res.body.hasMore, false);
    assert.equal(res.body.nextBefore, null);
  });
});

// ---- 结果内容与排序 -----------------------------------------------------

describe('消息搜索 · 结果内容', () => {
  it('每条结果都带会话标题、发送者名字和创建时间', async () => {
    const res = await search(chenToken, `${q('联调环境')}`);
    assert.equal(res.body.results.length, 1);
    const hit = res.body.results[0];
    assert.equal(hit.conversationId, ours.id);
    assert.equal(hit.conversationTitle, '发版协作');
    assert.equal(hit.conversationType, 'group');
    assert.equal(hit.senderName, '周明');
    assert.equal(hit.senderId, zhou.id);
    assert.ok(Number.isFinite(hit.createdAt) && hit.createdAt > 0);
    assert.ok(hit.body.includes('联调环境'));
  });

  it('一对一会话的标题是对方的名字（相对搜索者）', async () => {
    const mine = await search(chenToken, `${q('私聊里也提')}`);
    assert.equal(mine.body.results[0].conversationTitle, '周明', '陈子航看到的标题应当是周明');
    const theirsSide = await search(zhouToken, `${q('私聊里也提')}`);
    assert.equal(theirsSide.body.results[0].conversationTitle, '陈子航', '周明看到的标题应当是陈子航');
  });

  it('结果按时间倒序，最新的在最前面', async () => {
    const room = await group(api, adminToken, '排序群', [chen.id]);
    for (let i = 1; i <= 5; i += 1) await say(room.id, adminToken, `排序样本 第 ${i} 条`);

    const res = await search(chenToken, `${q('排序样本')}&conversationId=${room.id}`);
    const times = res.body.results.map((r) => r.createdAt);
    assert.deepEqual(times, [...times].sort((a, b) => b - a), '应当由新到旧');
    assert.match(res.body.results[0].body, /第 5 条/);
  });

  it('成员变动之类的系统提示不进搜索结果', async () => {
    const room = await group(api, adminToken, '系统提示群', [chen.id]);
    await api.post(`/api/conversations/${room.id}/members`, { userIds: [zhou.id] }, adminToken);
    // 上面这一步会写一条「…邀请…加入了群聊」的 system 消息
    const res = await search(chenToken, q('加入了群聊'));
    assert.deepEqual(res.body.results, [], '系统提示是界面说明文字，不是聊天内容');
  });
});

// ---- 分页游标 -----------------------------------------------------------

describe('消息搜索 · 游标翻页', () => {
  let room;

  it('用游标一直往前翻，不重不漏', async () => {
    room = await group(api, adminToken, '翻页搜索群', [chen.id]);
    for (let i = 1; i <= 25; i += 1) await say(room.id, adminToken, `翻页样本 ${i}`);

    const seen = [];
    let cursor = null;
    let guard = 0;
    for (;;) {
      const res = await search(chenToken, `${q('翻页样本')}&conversationId=${room.id}&limit=10${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(res.status, 200);
      seen.push(...res.body.results);
      cursor = res.body.nextBefore;
      if (!res.body.hasMore) break;
      guard += 1;
      assert.ok(guard < 10, '翻页没有收敛');
    }

    assert.equal(seen.length, 25);
    assert.equal(new Set(seen.map((m) => m.id)).size, 25, '不该有重复');
    const times = seen.map((m) => m.createdAt);
    assert.deepEqual(times, [...times].sort((a, b) => b - a), '跨页也应当保持倒序');
  });

  it('最后一页 hasMore 为 false 且不再给游标', async () => {
    const res = await search(chenToken, `${q('翻页样本')}&conversationId=${room.id}&limit=100`);
    assert.equal(res.body.results.length, 25);
    assert.equal(res.body.hasMore, false);
    assert.equal(res.body.nextBefore, null);
  });

  it('伪造的游标返回 400，而不是静默当成第一页', async () => {
    assert.equal((await search(chenToken, `${q('联调')}&before=m_不存在`)).status, 400);
  });

  it('别人会话里的消息 id 不能当游标用', async () => {
    const theirFirst = (await api.get(`/api/conversations/${theirs.id}/messages`, outsiderToken)).body.messages[0];
    const res = await search(chenToken, `${q('联调')}&before=${encodeURIComponent(theirFirst.id)}`);
    assert.equal(res.status, 400, '跨会话游标应当被拒绝');
  });

  it('限定会话时，别的（自己也在的）会话的消息 id 也不能当游标', async () => {
    const dmFirst = (await api.get(`/api/conversations/${dm.id}/messages`, chenToken)).body.messages[0];
    const res = await search(chenToken, `${q('联调')}&conversationId=${ours.id}&before=${encodeURIComponent(dmFirst.id)}`);
    assert.equal(res.status, 400);
  });

  it('limit 可以自定义，非法值退回默认，超上限被截断', async () => {
    const one = await search(chenToken, `${q('翻页样本')}&conversationId=${room.id}&limit=1`);
    assert.equal(one.body.results.length, 1);
    assert.equal(one.body.hasMore, true);

    const bad = await search(chenToken, `${q('翻页样本')}&conversationId=${room.id}&limit=abc`);
    assert.equal(bad.body.results.length, 25, '非法 limit 应当退回默认页大小（25 < 30）');

    const huge = await search(chenToken, `${q('翻页样本')}&conversationId=${room.id}&limit=99999`);
    assert.ok(huge.body.results.length <= 100, '应当被 MAX_SEARCH_PAGE_SIZE 截断');
  });
});
