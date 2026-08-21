import { startServer } from './helpers.js';
import { direct, member } from './fixtures.js';
import { PNG, TEXT } from './samples.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, token, dm;

const upload = async (buffer, { filename = 'shot.png', type = 'image/png' } = {}) => {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), filename);
  return api.call('POST', '/api/uploads', { token, form });
};

before(async () => {
  api = await startServer();
  token = await api.loginAdmin();
  const chen = await member('陈子航', { dept: '后端' });
  dm = await direct(api, token, chen.id);
});
after(async () => { await api.close(); });

describe('图片附件', () => {
  it('上传后返回可访问的链接', async () => {
    const res = await upload(PNG);
    assert.equal(res.status, 201);
    assert.match(res.body.url, /^\/uploads\//);
    assert.equal(res.body.filename, 'shot.png');
    assert.equal(res.body.kind, 'image');
    assert.equal(res.body.storage, 'local');

    // 附件回源现在要凭据了（只有该附件所在会话的成员能下载，见 attachment-access.js）；
    // 刚上传还没发出去的对象，上传者本人取得回来。
    const served = await fetch(`${api.baseUrl}${res.body.url}?token=${encodeURIComponent(token)}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await served.arrayBuffer()).length, PNG.length);
  });

  it('每次上传拿到独立的 key，不会互相覆盖', async () => {
    const a = await upload(PNG);
    const b = await upload(PNG);
    assert.notEqual(a.body.url, b.body.url);
  });

  it('不是图片就走文件通道，不再一律拒绝', async () => {
    // 以前这里是 400「只支持图片附件」。现在普通文件也能发，只是落盘成 .bin、
    // 回源强制下载，永远不会被当网页执行 —— 分流方案见 server/src/attachments.js。
    const res = await upload(TEXT, { filename: 'note.txt', type: 'text/plain' });
    assert.equal(res.status, 201);
    assert.equal(res.body.kind, 'file');
    assert.match(res.body.url, /\.bin$/);
  });

  it('未登录不能上传', async () => {
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'shot.png');
    const res = await fetch(`${api.baseUrl}/api/uploads`, { method: 'POST', body: form });
    assert.equal(res.status, 401);
  });

  it('链接可以拼进消息，按 Markdown 图片发送', async () => {
    const { body: file } = await upload(PNG);
    const sent = await api.post(`/api/conversations/${dm.id}/messages`, { body: `![发版流程](${file.url})` }, token);
    assert.equal(sent.status, 201);
    assert.match(sent.body.message.body, /^!\[发版流程\]\(\/uploads\/.+\)$/);

    const list = (await api.get(`/api/conversations/${dm.id}`, token)).body.conversation;
    assert.match(list.lastMessage.preview, /\[图片\]/);
  });

  it('文件附件拼成普通链接，会话预览显示「[文件] 名字」', async () => {
    const { body: file } = await upload(TEXT, { filename: '发版清单.pdf', type: 'application/pdf' });
    assert.equal(file.filename, '发版清单.pdf');
    const sent = await api.post(`/api/conversations/${dm.id}/messages`, { body: `[${file.filename}](${file.url})` }, token);
    assert.equal(sent.status, 201);

    const list = (await api.get(`/api/conversations/${dm.id}`, token)).body.conversation;
    assert.match(list.lastMessage.preview, /\[文件\] 发版清单\.pdf/);
  });
});
