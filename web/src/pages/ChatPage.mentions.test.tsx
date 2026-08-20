// 会话列表里「有人 @ 我」的未读徽标：和普通未读必须能区分开，
// 而且不能只有颜色差异 —— 读屏用户拿到的只有 aria-label。
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatPage } from './ChatPage';
import type { Conversation, User } from '../lib/types';

const me: User = {
  id: 'u_lin', name: '林悦', email: 'lin@loop.dev', dept: '产品',
  role: 'admin', avatarUrl: null, isAI: false, online: true,
};

const convo = (id: string, title: string, unread: number, mentionsUnread?: number): Conversation => ({
  id, type: 'group', title, peerId: null, createdBy: null,
  members: [
    { ...me, roleInGroup: '产品' },
    { id: 'u_chen', name: '陈子航', email: 'c@loop.dev', dept: '后端', role: 'member',
      avatarUrl: null, isAI: false, online: true, roleInGroup: '后端' },
  ],
  lastMessage: { preview: '在吗', createdAt: 1_700_000_000_000 },
  unread,
  ...(mentionsUnread === undefined ? {} : { mentionsUnread }),
});

const view = (conversations: Conversation[]) =>
  render(
    <ChatPage
      me={me}
      conversations={conversations}
      activeId={null}
      messages={[]}
      typing={false}
      aiProviderLabel="模拟供应商"
      silentRead={false}
      canCreateGroup
      showChatOnMobile={false}
      reads={[]}
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={vi.fn()}
      onSelect={vi.fn()}
      onBack={vi.fn()}
      onSend={vi.fn()}
      onCreateGroup={vi.fn()}
      onAddMembers={vi.fn()}
      onRemoveMember={vi.fn()}
      onRenameGroup={vi.fn()}
      onLeaveGroup={vi.fn()}
    />,
  );

describe('会话列表 · 有人 @ 我的未读徽标', () => {
  it('有 @ 我时无障碍名称说清有几条，而不是只报总未读', () => {
    view([convo('c1', '发版协作', 5, 2)]);
    expect(screen.getByLabelText('5 条未读，其中 2 条 @ 我')).toBeInTheDocument();
    expect(screen.queryByLabelText('5 条未读')).not.toBeInTheDocument();
  });

  it('没有 @ 我时沿用原来的说法', () => {
    view([convo('c1', '发版协作', 5, 0)]);
    expect(screen.getByLabelText('5 条未读')).toBeInTheDocument();
  });

  it('两种徽标样式不同：有 @ 我的那条带 badge--mention', () => {
    view([convo('c1', '发版协作', 3, 1), convo('c2', '日常闲聊', 4, 0)]);
    const mentioned = screen.getByLabelText('3 条未读，其中 1 条 @ 我');
    const plain = screen.getByLabelText('4 条未读');
    expect(mentioned).toHaveClass('badge', 'badge--mention');
    expect(plain).toHaveClass('badge');
    expect(plain).not.toHaveClass('badge--mention');
  });

  it('除了颜色还给一个 @ 记号，但对读屏隐藏，免得名称里念两遍', () => {
    view([convo('c1', '发版协作', 3, 1)]);
    const badge = screen.getByLabelText('3 条未读，其中 1 条 @ 我');
    expect(badge).toHaveTextContent('@3');
    expect(badge.querySelector('.badge__at')).toHaveAttribute('aria-hidden', 'true');
  });

  it('徽标上的数字仍是总未读，超过 99 照样收成 99+', () => {
    view([convo('c1', '发版协作', 128, 3)]);
    expect(screen.getByLabelText('128 条未读，其中 3 条 @ 我')).toHaveTextContent('99+');
  });

  it('接口没给 mentionsUnread 时按没有 @ 处理，不误报高亮', () => {
    view([convo('c1', '发版协作', 2)]);
    const badge = screen.getByLabelText('2 条未读');
    expect(badge).not.toHaveClass('badge--mention');
  });

  it('未读为 0 时两种徽标都不显示', () => {
    view([convo('c1', '发版协作', 0, 0)]);
    expect(screen.queryByLabelText(/条未读/)).not.toBeInTheDocument();
  });
});
