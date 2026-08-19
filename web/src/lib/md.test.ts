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
