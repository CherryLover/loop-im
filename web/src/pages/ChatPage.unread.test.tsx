// 会话列表的未读徽标。
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatPage } from './ChatPage';
import type { Conversation, User } from '../lib/types';

const me: User = {
  id: 'u_lin', name: '林悦', email: 'lin@loop.dev', dept: '产品',
  role: 'admin', avatarUrl: null, isAI: false, online: true,
};

const convo = (id: string, title: string, unread: number): Conversation => ({
  id, type: 'dm', title, peerId: 'u_chen',
  members: [
    { ...me, roleInGroup: '产品' },
    { id: 'u_chen', name: '陈子航', email: 'c@loop.dev', dept: '后端', role: 'member',
      avatarUrl: null, isAI: false, online: true, roleInGroup: '后端' },
  ],
  lastMessage: { preview: '在吗', createdAt: 1_700_000_000_000 },
  unread,
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
    />,
  );

describe('会话列表的未读徽标', () => {
  it('有未读时显示条数，没有未读时不显示', () => {
    view([convo('c1', '陈子航', 3), convo('c2', '周明', 0)]);
    expect(screen.getByLabelText('3 条未读')).toHaveTextContent('3');
    expect(screen.queryByLabelText('0 条未读')).not.toBeInTheDocument();
  });

  it('超过 99 条显示 99+，不让徽标被撑变形', () => {
    view([convo('c1', '陈子航', 128)]);
    expect(screen.getByLabelText('128 条未读')).toHaveTextContent('99+');
  });

  it('徽标带可读的无障碍名称，不是光秃秃一个数字', () => {
    view([convo('c1', '陈子航', 5)]);
    expect(screen.getByLabelText('5 条未读')).toBeInTheDocument();
  });
});
