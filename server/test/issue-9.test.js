import './helpers.js';
// issue #9：图片超过 8MB 时，multer 抛出的是英文提示（File too large），状态码也不是 413。
// 这里锁住「中文提示 + 413」的行为，聊天附件和头像两条上传口保持一致。
import { startServer } from './helpers.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, token;

// Smallest valid PNG (1×1, transparent).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const OVERSIZED = Buffer.alloc(9 * 1024 * 1024, 1);

const post = (path, buffer) => {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/png' }), 'shot.png');
  return api.call('POST', path, { token, form });
};

before(async () => {
  api = await startServer();
  token = await api.loginAdmin();
});
after(async () => { await api.close(); });

describe('图片体积上限', () => {
  it('聊天附件超过 8MB 返回 413 和中文提示', async () => {
    const res = await post('/api/uploads', OVERSIZED);
    assert.equal(res.status, 413);
    assert.match(res.body.error, /8\s*MB/);
    assert.doesNotMatch(res.body.error, /File too large/i);
  });

  it('头像超过 8MB 也是同一套提示', async () => {
    const res = await post('/api/auth/me/avatar', OVERSIZED);
    assert.equal(res.status, 413);
    assert.match(res.body.error, /8\s*MB/);
    assert.doesNotMatch(res.body.error, /File too large/i);
  });

  it('没超限的图片照常上传成功', async () => {
    assert.equal((await post('/api/uploads', PNG)).status, 201);
    assert.equal((await post('/api/auth/me/avatar', PNG)).status, 200);
  });
});
