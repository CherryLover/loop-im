import './helpers.js';
// issue #15：busboy 的 limits.fileSize 是「不得达到」而不是「不得超过」，服务端真正放行的
// 上限只到 8MB-1 字节，正好 8MB 会被 413；而前端 checkSize 用严格大于，这一档是放行的。
// 结果这一档图片绕过本地拦截、白跑一趟服务端才失败——正是 #9 加本地拦截要省掉的那一趟。
// 这里把边界的三个字节数钉死，避免以后有人把 upload-middleware.js 里的 +1 当成笔误删掉。
import { startServer } from './helpers.js';
import { pngOfSize } from './samples.js';
import { MAX_UPLOAD_BYTES } from '../src/upload-middleware.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, token;

// 样本必须是**指定字节数的合法 PNG**：issue #22 之后服务端会按真实字节嗅探，
// 原来那片 Buffer.alloc(size, 1) 不再是图片，撞到的会是格式判定而不是体积判定，
// 这条边界用例就名存实亡了。pngOfSize 用一个 tEXt 填充块把尺寸凑到精确值。
const bytes = (size) => pngOfSize(size);

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

describe('8MB 边界', () => {
  it('上限常量就是 8388608 字节', () => {
    assert.equal(MAX_UPLOAD_BYTES, 8388608);
  });

  it('8MB 差一个字节（8388607）的聊天附件上传成功', async () => {
    assert.equal((await post('/api/uploads', bytes(MAX_UPLOAD_BYTES - 1))).status, 201);
  });

  it('正好 8MB（8388608）的聊天附件上传成功', async () => {
    // 界面文案写的是「不超过 8MB」，按字面理解应当包含 8MB 这一档。
    assert.equal((await post('/api/uploads', bytes(MAX_UPLOAD_BYTES))).status, 201);
  });

  it('超出一个字节（8388609）的聊天附件仍然是 413 + 中文提示', async () => {
    const res = await post('/api/uploads', bytes(MAX_UPLOAD_BYTES + 1));
    assert.equal(res.status, 413);
    assert.match(res.body.error, /8\s*MB/);
    assert.doesNotMatch(res.body.error, /File too large/i);
  });

  it('头像入口在同样三档上结论一致', async () => {
    // 两条上传口共用同一个 multer 实例，这里防的是以后有人给头像单独配一套 limits。
    assert.equal((await post('/api/auth/me/avatar', bytes(MAX_UPLOAD_BYTES - 1))).status, 200);
    assert.equal((await post('/api/auth/me/avatar', bytes(MAX_UPLOAD_BYTES))).status, 200);

    const res = await post('/api/auth/me/avatar', bytes(MAX_UPLOAD_BYTES + 1));
    assert.equal(res.status, 413);
    assert.match(res.body.error, /8\s*MB/);
    assert.doesNotMatch(res.body.error, /File too large/i);
  });
});
