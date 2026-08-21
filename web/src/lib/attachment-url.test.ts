/**
 * 附件地址要带上凭据。
 *
 * /uploads 从「谁都能下载」改成了「该附件所在会话的成员才能下载」，可是 <img src> 和
 * <a href> 都没法带 Authorization 头 —— 只能把 token 放进查询串，和 /api/stream 的
 * EventSource 一个路子（服务端 auth.js 的 readToken 两种都认）。
 *
 * 没登录时必须原样返回：拼一个空 token 上去只会让 URL 变脏，还挡不住任何东西。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachmentUrl, setToken, clearToken } from './api';
import { renderMarkdown } from './md';

beforeEach(() => { clearToken(); });
afterEach(() => { clearToken(); });

describe('attachmentUrl', () => {
  it('登录后给站内附件地址补上 token', () => {
    setToken('tok-abc');
    expect(attachmentUrl('/uploads/9f3a.png')).toBe('/uploads/9f3a.png?token=tok-abc');
  });

  it('token 里的特殊字符要转义，别把查询串撑破', () => {
    setToken('a/b c&d');
    expect(attachmentUrl('/uploads/9f3a.png')).toBe('/uploads/9f3a.png?token=a%2Fb%20c%26d');
  });

  it('没登录就原样返回，不拼一个空 token 上去', () => {
    expect(attachmentUrl('/uploads/9f3a.png')).toBe('/uploads/9f3a.png');
  });

  it('只管站内附件：外链和 data: 图一律不碰', () => {
    setToken('tok-abc');
    expect(attachmentUrl('https://loop.dev/logo.png')).toBe('https://loop.dev/logo.png');
    expect(attachmentUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(attachmentUrl('#')).toBe('#');
  });

  it('sessionStorage 那一档（不勾「保持登录」）同样能取到凭据', () => {
    setToken('tok-session', false);
    expect(attachmentUrl('/uploads/9f3a.png')).toBe('/uploads/9f3a.png?token=tok-session');
  });
});

describe('渲染出来的附件链接带凭据', () => {
  it('图片的 src 带上 token', () => {
    setToken('tok-abc');
    expect(renderMarkdown('![发版流程](/uploads/9f3a.png)'))
      .toContain('src="/uploads/9f3a.png?token=tok-abc"');
  });

  it('文件卡片的 href 带上 token，download 名字不受影响', () => {
    setToken('tok-abc');
    const html = renderMarkdown('[发版清单.pdf](/uploads/9f3a.bin)');
    expect(html).toContain('href="/uploads/9f3a.bin?token=tok-abc"');
    expect(html).toContain('download="发版清单.pdf"');
    // 仍然是文件卡片，绝不内联 —— 真正拦住脚本执行的是服务端响应头，这里只是行为更直白。
    expect(html).toContain('class="filecard"');
  });

  it('未登录时渲染结果和改造前一模一样（测试和登录页都会走到这条分支）', () => {
    expect(renderMarkdown('![发版流程](/uploads/9f3a.png)'))
      .toContain('<img alt="发版流程" src="/uploads/9f3a.png">');
  });

  it('聊天里的普通外链不会被顺手加上凭据（别把 token 漏给第三方站点）', () => {
    setToken('tok-abc');
    const html = renderMarkdown('见 [文档](https://loop.dev/doc)');
    expect(html).toContain('href="https://loop.dev/doc"');
    expect(html).not.toContain('tok-abc');
  });
});
