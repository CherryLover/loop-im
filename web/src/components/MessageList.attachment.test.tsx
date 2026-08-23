// 消息气泡里的两档附件（配合 issue #22 的分流方案）：
// 图片内联成 <img>；非图片附件渲染成「文件卡片 + 下载」，绝不内联、绝不当页面打开。
// 渲染逻辑本身在 lib/md.ts 里（MessageList 通过 renderMarkdown 走这条路），
// 这里从真正会显示给用户的那一层再钉一遍。
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MessageList } from './MessageList';
import type { Message } from '../lib/types';

const message = (body: string): Message => ({
  id: 'm_1',
  conversationId: 'c1',
  senderId: 'u_chen',
  senderName: '陈子航',
  senderAvatarUrl: null,
  body,
  mentions: [],
  createdAt: 1_700_000_000_000,
  isAI: false,
});

const view = (body: string) =>
  render(
    <MessageList
      messages={[message(body)]}
      meId="u_lin"
      showSenderName
      aiProviderLabel="模拟供应商"
      typing={false}
    />,
  );

describe('消息里的附件', () => {
  it('图片附件内联成 img', () => {
    const { container } = view('![发版流程](/uploads/9f3a.png)');
    const img = container.querySelector('.bubble img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('/uploads/9f3a.png');
  });

  it('文件附件是一张带下载的文件卡片，不是内联内容', () => {
    const { container } = view('[发版清单.pdf](/uploads/9f3a.bin)');
    const card = container.querySelector('a.filecard') as HTMLAnchorElement;
    expect(card).not.toBeNull();
    expect(card.getAttribute('href')).toBe('/uploads/9f3a.bin');
    expect(card.getAttribute('download')).toBe('发版清单.pdf');
    expect(card.textContent).toContain('发版清单.pdf');
    expect(card.textContent).toContain('点击下载');

    // 不会被当成图片，也不会被塞进任何能执行的容器里。
    expect(container.querySelector('.bubble img')).toBeNull();
    expect(container.querySelector('iframe, object, embed, script')).toBeNull();
  });

  it('正文和附件可以同时出现', () => {
    // 输入框现在会把正文和附件拆成两条消息发（见 Composer.split.test.tsx），
    // 但历史消息里拼在一起的那种正文仍然在库里，渲染这一层要继续认。
    const { container } = view('这版的清单在附件里\n\n[发版清单.pdf](/uploads/9f3a.bin)');
    expect(container.textContent).toContain('这版的清单在附件里');
    expect(container.querySelector('a.filecard')).not.toBeNull();
  });

  // jsdom 里 <video> 的 play()/canPlayType 都是桩，这里只能确认气泡里长出了正确的元素和
  // 属性。「点下去真的能播、拖进度条真的发 Range 请求」要靠真实浏览器，单测覆盖不到。
  it('视频附件内联成原生播放器，不是文件卡片', () => {
    const { container } = view('[晨会录屏.mp4](/uploads/9f3a.mp4)');
    const video = container.querySelector('.bubble video') as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.getAttribute('src')).toBe('/uploads/9f3a.mp4');
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(video.hasAttribute('playsinline')).toBe(true);

    expect(container.querySelector('a.filecard')).toBeNull();
    // 没有引入任何播放器库，气泡里也没有多出别的容器。
    expect(container.querySelector('iframe, object, embed, script')).toBeNull();
  });
});
