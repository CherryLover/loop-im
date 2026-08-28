// 消息分页：默认只返回最新一页，用 before 游标往前翻。
import { startServer } from './helpers.js';
import { group, member } from './fixtures.js';
import { after, before as beforeAll, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, adminToken, chenToken, room;
const TOTAL = 120;   // 明显超过默认页大小 50

beforeAll(async () => {
  api = await startServer();
  adminToken = await api.loginAdmin();
  const chen = await member('陈子航', { dept: '后端' });
  const zhou = await member('周明', { dept: '前端' });
  chenToken = await api.login(chen.email);
  room = await group(api, adminToken, '分页测试群', [chen.id, zhou.id]);

  for (let i = 1; i <= TOTAL; i += 1) {
    await api.post(`/api/conversations/${room.id}/messages`, { body: `第 ${i} 条` }, chenToken);
  }
});
after(async () => { await api.close(); });

const pageOf = (query = '') => api.get(`/api/conversations/${room.id}/messages${query}`, chenToken);

describe('消息分页', () => {
  it('默认只返回最新一页，并告知还有更早的', async () => {
    const res = await pageOf();
    assert.equal(res.status, 200);
    assert.equal(res.body.messages.length, 50, '默认页大小应当是 50');
    assert.equal(res.body.hasMore, true);
    assert.ok(res.body.nextBefore, '还有更早的消息时应当给出游标');

    // 返回的是最新的 50 条，且仍然按由早到晚排列
    const bodies = res.body.messages.map((m) => m.body);
    assert.equal(bodies.at(-1), `第 ${TOTAL} 条`, '最后一条应当是最新消息');
    assert.equal(bodies[0], `第 ${TOTAL - 49} 条`);
    const times = res.body.messages.map((m) => m.createdAt);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), '应当由早到晚');
  });

  it('用游标一直往前翻，能不重不漏地取回全部历史', async () => {
    const seen = [];
    let cursor = null;
    let guard = 0;
    for (;;) {
      const res = await pageOf(cursor ? `?before=${encodeURIComponent(cursor)}` : '');
      assert.equal(res.status, 200);
      seen.unshift(...res.body.messages);
      cursor = res.body.nextBefore;
      if (!res.body.hasMore) break;
      guard += 1;
      assert.ok(guard < 20, '翻页没有收敛');
    }

    // 新群创建时没有任何消息，翻完正好是我们发的 TOTAL 条
    assert.equal(seen.length, TOTAL);
    const ids = seen.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, '翻页不应出现重复消息');

    const mine = seen.filter((m) => m.body.startsWith('第 '));
    assert.equal(mine.length, TOTAL, '不应漏消息');
    assert.equal(mine[0].body, '第 1 条');
    assert.equal(mine.at(-1).body, `第 ${TOTAL} 条`);
  });

  it('limit 可以自定义，并且有上限保护', async () => {
    assert.equal((await pageOf('?limit=10')).body.messages.length, 10);
    assert.equal((await pageOf('?limit=1')).body.messages.length, 1);
    // 超过上限时按上限截断，而不是把整库拉出来
    const huge = await pageOf('?limit=99999');
    assert.ok(huge.body.messages.length <= 200, '应当被 MAX_PAGE_SIZE 截断');
    // 非法值退回默认
    assert.equal((await pageOf('?limit=abc')).body.messages.length, 50);
    assert.equal((await pageOf('?limit=-5')).body.messages.length, 50);
  });

  it('最后一页 hasMore 为 false 且不再给游标', async () => {
    const res = await pageOf('?limit=200');
    assert.equal(res.body.messages.length, TOTAL);
    assert.equal(res.body.hasMore, false);
    assert.equal(res.body.nextBefore, null);
  });

  it('伪造的游标返回 400，而不是静默当成第一页', async () => {
    const res = await pageOf('?before=m_不存在的消息');
    assert.equal(res.status, 400);
  });

  it('别的会话的消息 id 不能当游标用（跨会话越权翻页）', async () => {
    const other = await group(api, adminToken, '另一个群', [
      (await member('外人甲')).id, (await member('外人乙')).id,
    ]);
    // 新群是空的，先发一条，拿它的 id 来当跨会话游标
    await api.post(`/api/conversations/${other.id}/messages`, { body: '另一个群里的一条' }, adminToken);
    const otherFirst = (await api.get(`/api/conversations/${other.id}/messages`, adminToken)).body.messages[0];
    const res = await pageOf(`?before=${encodeURIComponent(otherFirst.id)}`);
    assert.equal(res.status, 400, '跨会话的游标应当被拒绝');
  });

  it('不是会话成员依然拿不到消息', async () => {
    const outsider = await member('局外人');
    const token = await api.login(outsider.email);
    const res = await api.get(`/api/conversations/${room.id}/messages`, token);
    assert.equal(res.status, 404);
  });
});
