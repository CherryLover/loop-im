/**
 * 孤儿对象的定期清理。
 *
 * 起因：Composer 在**选中文件的那一刻**就调 /api/uploads 把文件传上去了。用户随后改主意
 * 移除附件、或者干脆不发这条消息，对象已经落库/落桶 —— 而在这次改造之前，全仓没有
 * 任何一处代码会删除对象，桶只会一直涨。
 *
 * 这个文件里最要紧的一条是「刚上传还没发送的对象不会被误删」：清理是个会真的删数据的
 * 后台任务，判定条件写松一点，用户选好文件正在打字的那几秒里附件就没了。
 */
import { startServer } from './helpers.js';
import { group, member } from './fixtures.js';
import { PNG } from './samples.js';
import { createMemoryStore } from '../src/object-store.js';
import { __setStoreForTest, resetStore } from '../src/storage.js';
import { findOrphanCandidates, orphanTtlMs, sweepOrphanObjects } from '../src/attachment-access.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, db, adminToken, chen, chenToken, room, store;

const HOUR = 60 * 60 * 1000;

const uploadAs = async (token) => {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'shot.png');
  const res = await api.call('POST', '/api/uploads', { token, form });
  assert.equal(res.status, 201);
  return { url: res.body.url, key: res.body.url.replace('/uploads/', '') };
};

const send = (id, body, token) => api.post(`/api/conversations/${id}/messages`, { body }, token);

/** 把某个附件的上传时间往前拨，模拟「它已经躺了很久」。 */
const ageBy = (url, ms) =>
  db.run('UPDATE attachments SET created_at = created_at - ? WHERE url = ?', ms, url);

const attachmentRow = (url) => db.get('SELECT * FROM attachments WHERE url = ?', url);

before(async () => {
  api = await startServer();
  db = await import('../src/db.js');
  adminToken = await api.loginAdmin();
  chen = await member('陈子航', { dept: '后端' });
  chenToken = await api.login(chen.email);
  await api.put('/api/ai/settings', { silentRead: false, replyAtAll: false, allowDm: true }, adminToken);
  room = await group(api, adminToken, '清理测试 · 群', [chen.id]);
  // 用内存实现跑，断言「对象真的被删了」比翻磁盘直观。
  process.env.S3_BUCKET = 'loop-im-test';
  process.env.UPLOADS_LOCAL_FALLBACK = '0';
});

beforeEach(() => {
  store = createMemoryStore();
  __setStoreForTest(store);
});

after(async () => {
  delete process.env.S3_BUCKET;
  delete process.env.UPLOADS_LOCAL_FALLBACK;
  resetStore();
  await api.close();
});

describe('孤儿清理 · 刚上传还没发送的对象不会被误删', () => {
  it('刚传上来、还没发出去 —— 默认 TTL 下一动不动', async () => {
    const { url, key } = await uploadAs(chenToken);

    const result = await sweepOrphanObjects();      // 默认 24 小时
    assert.equal(result.deleted, 0, '刚上传的对象一个都不该被删');
    assert.ok(store.objects.has(key), '对象必须还在');
    assert.ok(attachmentRow(url), 'attachments 那一行也必须还在');

    // 而且它仍然取得回来：用户还在打字，预览/发送都要用。
    const served = await fetch(`${api.baseUrl}${url}?token=${encodeURIComponent(chenToken)}`);
    assert.equal(served.status, 200);
  });

  it('躺了 23 小时仍然不删，24 小时之后才够格（默认 TTL = 24 小时）', async () => {
    const { url, key } = await uploadAs(chenToken);
    assert.equal(orphanTtlMs(), 24 * HOUR);

    ageBy(url, 23 * HOUR);
    assert.equal((await sweepOrphanObjects()).deleted, 0, '23 小时还没到期');
    assert.ok(store.objects.has(key));

    ageBy(url, 2 * HOUR);                            // 累计 25 小时
    assert.equal((await sweepOrphanObjects()).deleted, 1);
    assert.equal(store.objects.has(key), false, '对象应当被删掉');
    assert.equal(attachmentRow(url), undefined, 'attachments 那一行也要一起清掉');
  });

  it('TTL 可配置', () => {
    process.env.UPLOAD_ORPHAN_TTL_HOURS = '2';
    assert.equal(orphanTtlMs(), 2 * HOUR);
    process.env.UPLOAD_ORPHAN_TTL_HOURS = '不是数字';
    assert.equal(orphanTtlMs(), 24 * HOUR, '配歪了退回默认值，不要变成 0（那会当场删光）');
    delete process.env.UPLOAD_ORPHAN_TTL_HOURS;
  });
});

describe('孤儿清理 · 已经发出去的对象一律不动', () => {
  it('发进会话的附件，哪怕过了 TTL 也不会被删', async () => {
    const { url, key } = await uploadAs(chenToken);
    await send(room.id, `![截图](${url})`, chenToken);

    ageBy(url, 90 * 24 * HOUR);                      // 躺了三个月，照样不动
    assert.equal((await sweepOrphanObjects()).deleted, 0);
    assert.ok(store.objects.has(key));
  });

  it('引用没记上但正文里明明白白写着 —— 兜底那一条也拦得住', async () => {
    const { url, key } = await uploadAs(chenToken);
    await send(room.id, `![截图](${url})`, chenToken);
    // 模拟「linkAttachmentsToMessage 漏了」：把 ref 删掉，只剩正文里的链接。
    db.run("DELETE FROM attachment_refs WHERE key = ?", key);

    ageBy(url, 48 * HOUR);
    assert.equal((await sweepOrphanObjects()).deleted, 0, '正文引用着的对象绝不能删');
    assert.ok(store.objects.has(key));
  });
});

describe('孤儿清理 · 头像不受影响', () => {
  it('头像不进 attachments 表，也不会被扫到', async () => {
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'me.png');
    const res = await api.call('POST', '/api/auth/me/avatar', { token: chenToken, form });
    const key = res.body.user.avatarUrl.replace('/uploads/', '');

    const candidates = findOrphanCandidates({ olderThanMs: 0 });
    assert.equal(candidates.some((c) => c.url === res.body.user.avatarUrl), false);
    assert.equal((await sweepOrphanObjects({ olderThanMs: 0 })).scanned >= 0, true);
    assert.ok(store.objects.has(key), '头像不该被清理任务碰');
  });
});

describe('孤儿清理 · 判定条件', () => {
  it('TTL 传 0 时，未发送的对象立刻够格（用来验判定本身，不是默认行为）', async () => {
    const { url, key } = await uploadAs(chenToken);
    const result = await sweepOrphanObjects({ olderThanMs: 0 });
    assert.ok(result.deleted >= 1);
    assert.equal(store.objects.has(key), false);
    assert.equal(attachmentRow(url), undefined);
  });

  it('没有 attachments 行的历史对象一律不碰：删错了没法恢复，漏删只是占磁盘', async () => {
    await store.put('mystery-legacy.png', PNG, 'image/png');
    await sweepOrphanObjects({ olderThanMs: 0 });
    assert.ok(store.objects.has('mystery-legacy.png'));
  });

  it('消息被删掉之后，它引用的附件重新变成孤儿并被回收', async () => {
    const { url, key } = await uploadAs(chenToken);
    const sent = await send(room.id, `![截图](${url})`, chenToken);
    assert.equal((await sweepOrphanObjects({ olderThanMs: 0 })).deleted, 0);

    // 删消息会级联删掉 attachment_refs（外键），正文也跟着没了。
    db.run('DELETE FROM messages WHERE id = ?', sent.body.message.id);
    assert.equal((await sweepOrphanObjects({ olderThanMs: 0 })).deleted, 1);
    assert.equal(store.objects.has(key), false);
  });

  it('删不掉的对象不会连累 attachments 行：留着下一轮再试', async () => {
    const { url } = await uploadAs(chenToken);
    __setStoreForTest({
      name: 'memory',
      async put() {}, async get() { return null; },
      async remove() { throw new Error('对象存储暂时不可用'); },
    });
    const result = await sweepOrphanObjects({ olderThanMs: 0 });
    assert.equal(result.failed >= 1, true);
    assert.ok(attachmentRow(url), '对象没删掉就不能把记录删了，否则再也找不到它');
  });
});
