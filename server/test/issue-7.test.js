import { startServer } from './helpers.js';
import { direct, member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// issue #7：接口只记录「消息存下来了」，从来没有统计过谁看过，
// 所以消息里不能出现任何已读字段，前端也就无从把送达当成已读。
let api, adminToken, chen, dm;

const READ_FIELDS = ['read', 'isRead', 'readAt', 'readBy', 'seen', 'seenAt', 'delivered', 'deliveredAt'];

before(async () => {
  api = await startServer();
  adminToken = await api.loginAdmin();
  chen = await member('陈子航', { dept: '后端' });
  dm = await direct(api, adminToken, chen.id);
});
after(async () => { await api.close(); });

describe('消息已读状态', () => {
  it('发给从未连线的成员，返回的消息不带任何已读标记', async () => {
    const res = await api.post(`/api/conversations/${dm.id}/messages`, { body: '在吗' }, adminToken);
    assert.equal(res.status, 201);
    for (const field of READ_FIELDS) {
      assert.equal(field in res.body.message, false, `消息不应带 ${field} 字段`);
    }
  });

  it('回读历史消息同样没有已读标记', async () => {
    const { body } = await api.get(`/api/conversations/${dm.id}/messages`, adminToken);
    const last = body.messages.at(-1);
    assert.equal(last.body, '在吗');
    for (const field of READ_FIELDS) {
      assert.equal(field in last, false, `消息不应带 ${field} 字段`);
    }
  });
});
