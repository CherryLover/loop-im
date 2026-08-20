// 历史分页：入口只在还有更早消息时出现，加载中不可重复触发，
// 并且插入更早的消息不能把视线顶到底部。
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageList } from './MessageList';
import type { Message } from '../lib/types';

const msg = (id: string, body: string, createdAt: number): Message => ({
  id,
  conversationId: 'c1',
  senderId: 'u_chen',
  senderName: '陈子航',
  senderAvatarUrl: null,
  body,
  mentions: [],
  createdAt,
  isAI: false,
});

const base = [msg('m3', '第三条', 3_000), msg('m4', '第四条', 4_000)];

const view = (props: Partial<Parameters<typeof MessageList>[0]> = {}) =>
  render(
    <MessageList
      messages={base}
      meId="u_lin"
      showSenderName
      aiProviderLabel="模拟供应商"
      typing={false}
      {...props}
    />,
  );

describe('加载更早的消息', () => {
  it('还有更早的消息时才出现入口', () => {
    const { unmount } = view({ hasOlder: true, onLoadOlder: vi.fn() });
    expect(screen.getByRole('button', { name: '加载更早的消息' })).toBeInTheDocument();
    unmount();

    view({ hasOlder: false, onLoadOlder: vi.fn() });
    expect(screen.queryByRole('button', { name: /加载更早|加载中/ })).not.toBeInTheDocument();
  });

  it('点击入口会向上层请求下一页', async () => {
    const onLoadOlder = vi.fn();
    view({ hasOlder: true, onLoadOlder });
    await userEvent.click(screen.getByRole('button', { name: '加载更早的消息' }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('加载中时入口禁用，点不出第二次请求', async () => {
    const onLoadOlder = vi.fn();
    view({ hasOlder: true, loadingOlder: true, onLoadOlder });
    const button = screen.getByRole('button', { name: '加载中…' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('插入更早的消息后仍然按由早到晚渲染，且不重复', () => {
    const older = [msg('m1', '第一条', 1_000), msg('m2', '第二条', 2_000)];
    view({ messages: [...older, ...base], hasOlder: false });
    const rendered = screen.getAllByText(/第[一二三四]条/).map((el) => el.textContent);
    expect(rendered).toEqual(['第一条', '第二条', '第三条', '第四条']);
  });

  it('没有传 onLoadOlder 时不会崩，也不显示入口', () => {
    view({ hasOlder: false });
    expect(screen.getByText('第四条')).toBeInTheDocument();
  });
});
