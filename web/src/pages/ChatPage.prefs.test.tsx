// 会话列表项上的置顶 / 免打扰入口与视觉标识。
// 排序由 AppShell 拿 lib/conversations.ts 做（另有用例），这里只管这一行长什么样、点了发生什么。
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatPage } from './ChatPage';
import type { Conversation, User } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: { searchMessages: vi.fn() },
}));

const me: User = {
  id: 'u_lin', name: '林悦', email: 'lin@loop.dev', dept: '产品',
  role: 'admin', avatarUrl: null, isAI: false, online: true,
};

const convo = (title: string, over: Partial<Conversation> = {}): Conversation => ({
  id: `c_${title}`,
  type: 'group',
  title,
  peerId: null,
  createdBy: me.id,
  members: [{ ...me, roleInGroup: '管理员' }],
  lastMessage: { preview: '在吗', createdAt: 1_700_000_000_000 },
  unread: 0,
  ...over,
});

const view = (conversations: Conversation[]) => {
  const onTogglePin = vi.fn();
  const onToggleMute = vi.fn();
  render(
    <ChatPage
      me={me}
      conversations={conversations}
      activeId={null}
      messages={[]}
      typing={false}
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
      onTogglePin={onTogglePin}
      onToggleMute={onToggleMute}
    />,
  );
  return { onTogglePin, onToggleMute };
};

describe('会话列表项的置顶入口', () => {
  it('没置顶时给出「置顶」按钮，点一下请求置顶', async () => {
    const { onTogglePin } = view([convo('发版协作')]);
    await userEvent.click(screen.getByRole('button', { name: '置顶「发版协作」' }));
    // 传的是「改成什么」，不是「当前是什么」
    expect(onTogglePin).toHaveBeenCalledWith('c_发版协作', true);
  });

  it('已置顶时按钮变成「取消置顶」，点一下请求取消', async () => {
    const { onTogglePin } = view([convo('发版协作', { pinned: true })]);
    await userEvent.click(screen.getByRole('button', { name: '取消置顶「发版协作」' }));
    expect(onTogglePin).toHaveBeenCalledWith('c_发版协作', false);
  });

  it('已置顶的会话带一个明确的置顶标识', () => {
    view([convo('发版协作', { pinned: true }), convo('日常闲聊')]);
    expect(screen.getAllByLabelText('已置顶')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '取消置顶「发版协作」' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '置顶「日常闲聊」' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('每一项各有各的按钮，不会互相串', async () => {
    const { onTogglePin } = view([convo('发版协作'), convo('日常闲聊')]);
    await userEvent.click(screen.getByRole('button', { name: '置顶「日常闲聊」' }));
    expect(onTogglePin).toHaveBeenCalledWith('c_日常闲聊', true);
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });
});

describe('会话列表项的免打扰入口', () => {
  it('没设免打扰时点一下请求开启', async () => {
    const { onToggleMute } = view([convo('发版协作')]);
    await userEvent.click(screen.getByRole('button', { name: '免打扰「发版协作」' }));
    expect(onToggleMute).toHaveBeenCalledWith('c_发版协作', true);
  });

  it('已免打扰时按钮变成「取消免打扰」，并带一个明确的标识', async () => {
    const { onToggleMute } = view([convo('发版协作', { muted: true })]);
    expect(screen.getByLabelText('已免打扰')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '取消免打扰「发版协作」' }));
    expect(onToggleMute).toHaveBeenCalledWith('c_发版协作', false);
  });

  it('置顶和免打扰互相独立，可以同时开着', () => {
    view([convo('发版协作', { pinned: true, muted: true })]);
    expect(screen.getByLabelText('已置顶')).toBeInTheDocument();
    expect(screen.getByLabelText('已免打扰')).toBeInTheDocument();
  });
});

describe('免打扰不影响未读，只让徽标弱化', () => {
  it('免打扰的会话照样显示未读数字', () => {
    view([convo('发版协作', { muted: true, unread: 3 })]);
    const badge = screen.getByLabelText('3 条未读');
    expect(badge).toHaveTextContent('3');
    // 弱化的那一档，不是普通档也不是 @我 的告警档
    expect(badge.className).toContain('badge--muted');
    expect(badge.className).not.toContain('badge--mention');
  });

  it('免打扰的会话里「@ 我」照样统计，只是徽标不再升级成告警色', () => {
    view([convo('发版协作', { muted: true, unread: 5, mentionsUnread: 2 })]);
    // 数字和无障碍名称都不打折：免打扰不是不计未读
    const badge = screen.getByLabelText('5 条未读，其中 2 条 @ 我');
    expect(badge).toHaveTextContent('5');
    expect(badge.className).toContain('badge--muted');
  });

  it('没设免打扰时徽标还是原来那两档', () => {
    view([convo('普通', { unread: 1 }), convo('被叫了', { unread: 4, mentionsUnread: 1 })]);
    expect(screen.getByLabelText('1 条未读').className).toBe('badge');
    expect(screen.getByLabelText('4 条未读，其中 1 条 @ 我').className).toContain('badge--mention');
  });
});
