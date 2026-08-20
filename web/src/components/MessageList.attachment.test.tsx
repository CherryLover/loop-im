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
    const { container } = view('这版的清单在附件里\n\n[发版清单.pdf](/uploads/9f3a.bin)');
    expect(container.textContent).toContain('这版的清单在附件里');
    expect(container.querySelector('a.filecard')).not.toBeNull();
  });
});
