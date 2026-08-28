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
import { findOrphanCandidates, orphanSweepEnabled, orphanTtlMs, startOrphanSweeper, sweepOrphanObjects } from '../src/attachment-access.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, db, adminToken, chen, chenToken, room, store;

const HOUR = 60 * 60 * 1000;

/**
 * 传一个文件，并把它的上传时间往前拨 1 毫秒。
 *
 * 那 1 毫秒不是凑数：判定条件是 `created_at < now - TTL`（严格小于，故意的 —— 宁可少删）。
 * 本文件多处用 `olderThanMs: 0` 来验判定本身，此时条件退化成 `created_at < now()`，
 * 于是「上传」和「清理」落在同一毫秒里就会判成不够格。跑整套时机器忙，天然差开 1ms 看不出来；
 * 单独跑这个文件时代码路径是热的，两步都在同一毫秒内完成，用例就会挂。
 * 与其把生产代码放宽成 `<=`（那等于扩大删除范围），不如让用例别卡在边界上。
 */
const uploadAs = async (token) => {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'shot.png');
  const res = await api.call('POST', '/api/uploads', { token, form });
  assert.equal(res.status, 201);
  ageBy(res.body.url, 1);
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

/**
 * 总开关。默认关闭是这套东西最要紧的一条设定：清理会真的删用户传上来的文件，
 * 而本项目的取向是程序层面不主动删数据。所以「不配置 = 什么都不删」必须有用例钉死，
 * 免得哪天有人手滑把默认值改回去，没有任何一处会报警。
 */
describe('孤儿清理 · 总开关', () => {
  const SWEEP = 'UPLOAD_ORPHAN_SWEEP';
  const INTERVAL = 'UPLOAD_SWEEP_INTERVAL_MINUTES';
  let stop = () => {};

  const restore = () => {
    stop();
    stop = () => {};
    delete process.env[SWEEP];
    delete process.env[INTERVAL];
  };

  beforeEach(restore);
  after(restore);

  it('不配置就是关的：默认一个字节都不删', () => {
    assert.equal(orphanSweepEnabled(), false);
  });

  it('认得几种常见的「开」写法，别人写 on / true / 1 都该生效', () => {
    for (const on of ['on', 'ON', 'true', 'True', '1', 'yes']) {
      process.env[SWEEP] = on;
      assert.equal(orphanSweepEnabled(), true, `${on} 应该算开`);
    }
    for (const off of ['off', 'false', '0', 'no', '', '   ']) {
      process.env[SWEEP] = off;
      assert.equal(orphanSweepEnabled(), false, `${off} 应该算关`);
    }
  });

  it('开关关着时，就算对象早就过了 TTL，后台定时器也永远不会动它', async () => {
    const { url, key } = await uploadAs(chenToken);
    ageBy(url, 100 * 24 * HOUR);                     // 躺了 100 天，按 TTL 早该删了
    process.env[INTERVAL] = '0.01';                  // 600ms 一轮，跑得完

    stop = startOrphanSweeper();
    await new Promise((r) => setTimeout(r, 900));    // 够跑好几轮了

    assert.ok(store.objects.has(key), '关着的时候对象必须还在');
    assert.ok(attachmentRow(url), 'attachments 那一行也必须还在');
  });

  it('显式打开之后，过了 TTL 的对象才会被后台定时器回收', async () => {
    const { url, key } = await uploadAs(chenToken);
    ageBy(url, 100 * 24 * HOUR);
    process.env[SWEEP] = 'on';
    process.env[INTERVAL] = '0.01';

    stop = startOrphanSweeper();
    // 轮询到删掉为止：断言「最终会发生」，不跟定时器的精确时刻较劲。
    const deadline = Date.now() + 5000;
    while (store.objects.has(key) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(store.objects.has(key), false, '开着的时候过期对象应该被回收');
    assert.equal(attachmentRow(url), undefined, '对象删掉了，记账那行也该跟着走');
  });

  it('开着，但对象还没到 TTL —— 一样不动（开关不改判定条件）', async () => {
    const { url, key } = await uploadAs(chenToken);   // 刚传，远没到 24 小时
    process.env[SWEEP] = 'on';
    process.env[INTERVAL] = '0.01';

    stop = startOrphanSweeper();
    await new Promise((r) => setTimeout(r, 900));

    assert.ok(store.objects.has(key), '没到 TTL 的对象不该被删');
    assert.ok(attachmentRow(url), 'attachments 那一行也必须还在');
  });
});
