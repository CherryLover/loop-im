import { describe, expect, it } from 'vitest';
import { initialOf, renderMarkdown } from './md';

describe('Markdown 渲染', () => {
  it('段落与加粗', () => {
    expect(renderMarkdown('第一行\n第二行')).toBe('<p>第一行</p><p>第二行</p>');
    expect(renderMarkdown('**周四** 完成')).toBe('<p><strong>周四</strong> 完成</p>');
  });

  it('列表', () => {
    expect(renderMarkdown('- 接口 2 项未完成\n- 回归测试 1 天'))
      .toBe('<ul><li>接口 2 项未完成</li><li>回归测试 1 天</li></ul>');
  });

  it('行内代码与链接', () => {
    expect(renderMarkdown('等 `/messages/sync`')).toContain('<code>/messages/sync</code>');
    expect(renderMarkdown('见 [文档](https://loop.dev/doc)'))
      .toContain('<a href="https://loop.dev/doc" target="_blank" rel="noreferrer">文档</a>');
  });

  it('图片渲染成 img，保留 alt', () => {
    expect(renderMarkdown('![发版流程](/uploads/a.png)'))
      .toContain('<img alt="发版流程" src="/uploads/a.png">');
  });

  it('@ 提及会被高亮', () => {
    expect(renderMarkdown('@Aria 看一下')).toContain('<strong class="mention">@Aria</strong>');
    expect(renderMarkdown('@全员 站会推迟')).toContain('<strong class="mention">@全员</strong>');
  });

  it('转义 HTML，不会执行注入的脚本', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('图片与链接里的 javascript: 协议会被拦掉', () => {
    expect(renderMarkdown('![x](javascript:alert(1))')).toContain('src="#"');
    expect(renderMarkdown('[x](javascript:alert(1))')).toContain('href="#"');
    expect(renderMarkdown('![x](/uploads/ok.png)')).toContain('src="/uploads/ok.png"');
  });

  it('引号不会撑破属性', () => {
    expect(renderMarkdown('![" onerror="alert(1)](/uploads/a.png)')).not.toContain('onerror="alert(1)"');
  });

  // ---- issue #22：站内相对链接这条路径 ----
  // md.ts 一直允许 /uploads/... 这类站内相对链接，所以恶意附件地址能被包装成一条普通聊天
  // 链接发出来。这条路径在新方案下是无害的：非图片附件在服务端一律落成 .bin，并且回源时带
  // Content-Disposition: attachment + application/octet-stream + nosniff，点开只会下载，
  // 不会有同源页面被渲染出来（服务端一侧的断言在 server/test/issue-22.test.js）。
  // 前端这一侧要保证的是：这类链接绝不被内联，而是渲染成明确的「文件卡片 + 下载」。
  it('站内 /uploads 链接渲染成文件卡片，带 download，不内联', () => {
    const html = renderMarkdown('[发版清单.pdf](/uploads/9f3a.bin)');
    expect(html).toContain('class="filecard"');
    expect(html).toContain('href="/uploads/9f3a.bin"');
    expect(html).toContain('download="发版清单.pdf"');
    expect(html).toContain('点击下载');
    // 不是 iframe/object/img，就是一个链接；正文里也没有任何脚本。
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<script');
  });

  it('伪装成图片的附件链接也只是一张坏图，不会变成可执行页面', () => {
    // 服务端给 .bin 回的是 octet-stream + nosniff，浏览器不会拿它当文档。
    expect(renderMarkdown('![伪装](/uploads/evil.bin)')).toBe('<p><img alt="伪装" src="/uploads/evil.bin"></p>');
  });

  it('文件名里的 @ 和 ** 不会把标签属性撑破', () => {
    // @提及、加粗这些行内规则是在标签生成之后跑的，属性值必须先被占位保护起来，
    // 否则 download="@报告.pdf" 会被改写成 download="<strong class="mention">…"。
    const html = renderMarkdown('[@报告**终版**.pdf](/uploads/9f3a.bin)');
    expect(html).toContain('download="@报告**终版**.pdf"');
    expect(html).toContain('href="/uploads/9f3a.bin"');
  });

  it('站外链接照旧是普通链接，不会被当成附件卡片', () => {
    const html = renderMarkdown('[文档](https://loop.dev/doc)');
    expect(html).not.toContain('filecard');
    expect(html).toContain('target="_blank"');
  });

  it('data:image/svg+xml 被挡掉（SVG 是可执行的 XML）', () => {
    expect(renderMarkdown('![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)')).toContain('src="#"');
    // 位图形式的 data URL 不受影响。
    expect(renderMarkdown('![x](data:image/png;base64,iVBORw0KGgo=)')).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });

  it('空内容渲染成空串', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   ')).toBe('');
  });
});

describe('头像首字', () => {
  it('中文取第一个字，Aria 用两位缩写', () => {
    expect(initialOf('林悦')).toBe('林');
    expect(initialOf('Aria')).toBe('Ar');
    expect(initialOf('')).toBe('?');
  });
});
