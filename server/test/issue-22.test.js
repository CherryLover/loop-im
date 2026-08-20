// issue #22（高危）：上传只信客户端自报的 Content-Type，落盘又沿用用户的原始扩展名。
// 一份 HTML 谎报成 image/png、取名 x.html，会以 .html 落盘，express.static 按网页返回，
// 脚本在和聊天系统同源的页面里执行，能读走 localStorage 里的登录 token。
//
// 修法是**按用途分流**（见 server/src/attachments.js）：图片按真实字节嗅探、扩展名由服务端定，
// 其余文件照收但落成 .bin 且强制下载。下面逐条覆盖 issue 里列的回归清单。
//
// 样本全部是真实字节（真 PNG 头、真 HTML、带 <script> 的真 SVG），见 ./samples.js。
import { startServer } from './helpers.js';
import { GIF, HTML, JPEG, PNG, SHELL, SVG, PDF, TEXT, WEBP, ZIP, pngOfSize } from './samples.js';
import { MAX_UPLOAD_BYTES } from '../src/upload-middleware.js';
import { UPLOAD_DIR } from '../src/db.js';
import { decodeUploadName, displayName, inspectUpload, setUploadHeaders } from '../src/attachments.js';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, token;

const post = (path, buffer, { filename = 'x.bin', type = 'application/octet-stream' } = {}) => {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), filename);
  return api.call('POST', path, { token, form });
};

const upload = (buffer, opts) => post('/api/uploads', buffer, opts);
const fetchUpload = (url) => fetch(`${api.baseUrl}${url}`);

before(async () => {
  api = await startServer();
  token = await api.loginAdmin();
});
after(async () => { await api.close(); });

describe('issue #22 · 谎报类型的上传', () => {
  it('HTML 谎报成 image/png 被拒（400），不落盘', async () => {
    const before = readdirSync(UPLOAD_DIR).length;
    const res = await upload(HTML, { filename: 'x.html', type: 'image/png' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /不是有效的图片/);
    assert.equal(readdirSync(UPLOAD_DIR).length, before);
  });

  it('改了扩展名也没用：HTML 取名 x.png、报 image/png，还是 400', async () => {
    const res = await upload(HTML, { filename: 'x.png', type: 'image/png' });
    assert.equal(res.status, 400);
  });

  it('损坏的图片（只有 PNG 头几个字节的残片）被图片通道拒绝', async () => {
    const broken = Buffer.concat([PNG.subarray(0, 4), Buffer.from('这不是图片的其余部分')]);
    const res = await upload(broken, { filename: 'broken.png', type: 'image/png' });
    assert.equal(res.status, 400);
  });

  it('SVG 一律拒绝，哪怕报的是 image/svg+xml 或伪装成二进制', async () => {
    for (const type of ['image/svg+xml', 'image/png', 'application/octet-stream', 'text/plain']) {
      const res = await upload(SVG, { filename: 'logo.svg', type });
      assert.equal(res.status, 400, `type=${type} 应当被拒`);
      assert.match(res.body.error, /SVG/);
    }
  });

  it('纯文本、脚本谎报成图片时也被图片通道拒绝', async () => {
    assert.equal((await upload(TEXT, { filename: 'a.png', type: 'image/png' })).status, 400);
    assert.equal((await upload(SHELL, { filename: 'a.gif', type: 'image/gif' })).status, 400);
  });

  it('头像口同样只认真实字节的图片', async () => {
    assert.equal((await post('/api/auth/me/avatar', HTML, { filename: 'a.png', type: 'image/png' })).status, 400);
    assert.equal((await post('/api/auth/me/avatar', SVG, { filename: 'a.svg', type: 'image/svg+xml' })).status, 400);
    // 头像不接受「普通文件」这一档：它一定会被渲染成 <img>。
    const pdf = await post('/api/auth/me/avatar', PDF, { filename: 'a.pdf', type: 'application/pdf' });
    assert.equal(pdf.status, 400);
    assert.match(pdf.body.error, /头像/);
    assert.equal((await post('/api/auth/me/avatar', PNG, { filename: 'a.png', type: 'image/png' })).status, 200);
  });
});

describe('issue #22 · 合法图片照常可用', () => {
  const cases = [
    ['PNG', PNG, 'image/png', '.png'],
    ['JPEG', JPEG, 'image/jpeg', '.jpg'],
    ['GIF', GIF, 'image/gif', '.gif'],
    ['WebP', WEBP, 'image/webp', '.webp'],
  ];

  for (const [label, buffer, mime, ext] of cases) {
    it(`${label} 能上传，扩展名由嗅探结果决定，回源按图片返回`, async () => {
      // 故意报一个和真实字节无关的 Content-Type、给一个恶意扩展名：
      // 服务端两个都不该采信，落盘用的是自己嗅出来的扩展名。
      const res = await upload(buffer, { filename: 'evil.html', type: 'text/html' });
      assert.equal(res.status, 201);
      assert.equal(res.body.kind, 'image');
      assert.equal(res.body.mime, mime);
      assert.ok(res.body.url.endsWith(ext), `${res.body.url} 应当以 ${ext} 结尾`);
      assert.ok(!res.body.url.includes('evil'), '用户的文件名不该出现在 URL 里');
      assert.equal(res.body.filename, 'evil.html');   // 只作为显示名保留

      const served = await fetchUpload(res.body.url);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), mime);
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(served.headers.get('content-disposition'), null);
      assert.deepEqual(Buffer.from(await served.arrayBuffer()), buffer);
    });
  }
});

describe('issue #22 · 非图片附件收下但只能下载', () => {
  const cases = [
    ['PDF', PDF, 'report.pdf', 'application/pdf'],
    ['ZIP', ZIP, '交付物.zip', 'application/zip'],
    ['DOCX', ZIP, '需求.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['纯文本', TEXT, 'note.txt', 'text/plain'],
    ['脚本', SHELL, 'deploy.sh', 'application/x-sh'],
    ['HTML', HTML, 'page.html', 'text/html'],
  ];

  for (const [label, buffer, filename, type] of cases) {
    it(`${label} 落盘成 .bin，回源强制下载`, async () => {
      const res = await upload(buffer, { filename, type });
      assert.equal(res.status, 201);
      assert.equal(res.body.kind, 'file');
      assert.equal(res.body.mime, 'application/octet-stream');
      assert.match(res.body.url, /^\/uploads\/[0-9a-f-]+\.bin$/);
      assert.equal(res.body.filename, filename);      // 原名只作为显示名回传

      const served = await fetchUpload(res.body.url);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), 'application/octet-stream');
      assert.equal(served.headers.get('content-disposition'), 'attachment');
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await served.arrayBuffer()), buffer);
    });
  }

  it('公开附件不能作为可执行网页运行', async () => {
    // 攻击者能做到的极限：把 HTML 老老实实按文件传上去，再把地址发进聊天。
    const { body } = await upload(HTML, { filename: 'steal.html', type: 'text/html' });
    const served = await fetchUpload(body.url);

    // 浏览器判断「这是不是一个要渲染的文档」看的就是这三样。
    assert.equal(served.headers.get('content-disposition'), 'attachment');
    assert.doesNotMatch(served.headers.get('content-type'), /html/i);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    // 再加一道：即便有人硬把它当文档打开，CSP 也不允许它执行任何脚本。
    assert.match(served.headers.get('content-security-policy'), /default-src 'none'/);
    // 内容原样保存（附件功能得真的可用），危险的只是「被当网页渲染」这件事。
    assert.equal(Buffer.from(await served.arrayBuffer()).toString('utf8'), HTML.toString('utf8'));
  });

  it('md.ts 里「站内相对链接」那条路径也已经无害', async () => {
    // web/src/lib/md.ts 允许 /uploads/... 这类站内相对链接，恶意附件地址能被包装成
    // 一条普通聊天链接。用户点开时浏览器拿到的仍然是上面那组「下载」响应头，
    // 不会有同源页面被渲染出来。前端一侧的对照断言在 web/src/lib/md.test.ts。
    const { body } = await upload(HTML, { filename: '季度报告.html', type: 'text/html' });
    const served = await fetchUpload(body.url);
    assert.equal(served.headers.get('content-disposition'), 'attachment');
    assert.equal(served.headers.get('content-type'), 'application/octet-stream');
  });
});

describe('issue #22 · 历史遗留文件', () => {
  it('修复之前落下的 .html 现在也按下载返回，不必等清理脚本', async () => {
    // 直接往 uploads 目录里放一个「旧世界」的文件，模拟升级前已经存在的攻击载荷。
    writeFileSync(join(UPLOAD_DIR, 'legacy-issue-22.html'), HTML);
    const served = await fetchUpload('/uploads/legacy-issue-22.html');
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-disposition'), 'attachment');
    assert.doesNotMatch(served.headers.get('content-type'), /html/i);
  });

  it('历史上的 .jpeg 图片仍然按图片内联，不会被这次修复变成下载', async () => {
    writeFileSync(join(UPLOAD_DIR, 'legacy-photo.jpeg'), JPEG);
    const served = await fetchUpload('/uploads/legacy-photo.jpeg');
    assert.equal(served.headers.get('content-type'), 'image/jpeg');
    assert.equal(served.headers.get('content-disposition'), null);
  });
});

describe('issue #22 · 8MB 边界没有被这次修复带坏', () => {
  // 详细的三档断言在 issue-15 那个文件里，这里只钉住 issue #22 回归清单点名的两档，
  // 而且用的是真的能通过嗅探的 PNG —— 否则撞到的是格式判定而不是体积判定。
  it('恰好 8MB（8388608）的图片继续上传成功', async () => {
    const res = await upload(pngOfSize(MAX_UPLOAD_BYTES), { filename: 'edge.png', type: 'image/png' });
    assert.equal(res.status, 201);
    assert.equal(res.body.kind, 'image');
  });

  it('8MB + 1 字节（8388609）继续返回 413', async () => {
    const res = await upload(pngOfSize(MAX_UPLOAD_BYTES + 1), { filename: 'edge.png', type: 'image/png' });
    assert.equal(res.status, 413);
    assert.match(res.body.error, /8\s*MB/);
  });

  it('非图片附件在同样两档上结论一致', async () => {
    const filler = (size) => Buffer.alloc(size, 0x41);   // 纯文本，走文件通道
    assert.equal((await upload(filler(MAX_UPLOAD_BYTES), { filename: 'big.bin' })).status, 201);
    assert.equal((await upload(filler(MAX_UPLOAD_BYTES + 1), { filename: 'big.bin' })).status, 413);
  });
});

describe('issue #22 · 判定函数本身', () => {
  it('文件名只当显示名：去掉路径、控制字符并限长', () => {
    assert.equal(displayName('../../etc/passwd'), 'passwd');
    assert.equal(displayName('C:\\Users\\lin\\报告.pdf'), '报告.pdf');
    assert.equal(displayName('a\u0000b\nc.txt'), 'abc.txt');
    assert.equal(displayName('   '), '附件');
    assert.equal(displayName(`${'长'.repeat(200)}.pdf`).length, 120);
  });

  it('中文文件名不会变成乱码（busboy 按 latin1 解，这里还原成 UTF-8）', () => {
    const mangled = Buffer.from('交付物.zip', 'utf8').toString('latin1');
    assert.equal(decodeUploadName(mangled), '交付物.zip');
    assert.equal(decodeUploadName('report.pdf'), 'report.pdf');   // 纯 ASCII 原样返回
  });

  it('不足 12 字节的内容一律算不出图片', () => {
    assert.equal(inspectUpload(PNG.subarray(0, 8), 'image/png').kind, 'rejected');
  });

  it('setUploadHeaders 只对白名单扩展名放行内联', () => {
    const seen = {};
    const res = { setHeader: (k, v) => { seen[k] = v; } };

    setUploadHeaders(res, '/data/uploads/a.PNG');           // 大小写不敏感
    assert.equal(seen['Content-Type'], 'image/png');
    assert.equal(seen['Content-Disposition'], undefined);

    for (const name of ['a.bin', 'a.html', 'a.svg', 'a.js', 'noext']) {
      const out = {};
      setUploadHeaders({ setHeader: (k, v) => { out[k] = v; } }, `/data/uploads/${name}`);
      assert.equal(out['Content-Type'], 'application/octet-stream', name);
      assert.equal(out['Content-Disposition'], 'attachment', name);
      assert.equal(out['X-Content-Type-Options'], 'nosniff', name);
    }
  });
});
