// 群管理入口的可见性：谁能看到「添加 / 移除 / 修改群名」，谁只能退群。
// 权限最终由服务端把关，这里保证界面不会给出用不了的入口。
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatPage } from './ChatPage';
import type { Conversation, User } from '../lib/types';

const person = (id: string, name: string, role: 'admin' | 'member' | 'ai' = 'member'): User => ({
  id, name, email: `${id}@loop.dev`, dept: '产品', role, avatarUrl: null, isAI: role === 'ai', online: true,
});

const OWNER = person('u_owner', '群主');
const OTHER = person('u_other', '陈子航');
const ARIA = person('ai', 'Aria', 'ai');

const room = (): Conversation => ({
  id: 'c_room',
  type: 'group',
  title: '发版协作',
  peerId: null,
  createdBy: OWNER.id,
  members: [OWNER, OTHER, ARIA].map((m) => ({ ...m, roleInGroup: m.id === OWNER.id ? '管理员' : m.dept })),
  lastMessage: null,
  unread: 0,
});

const view = (me: User, handlers: Record<string, ReturnType<typeof vi.fn>> = {}) => {
  const props = {
    onAddMembers: vi.fn(), onRemoveMember: vi.fn(), onRenameGroup: vi.fn(), onLeaveGroup: vi.fn(),
    onTogglePin: vi.fn(), onToggleMute: vi.fn(), ...handlers,
  };
  render(
    <ChatPage
      me={me}
      conversations={[room()]}
      activeId="c_room"
      messages={[]}
      typing={false}
      canCreateGroup
      showChatOnMobile
      reads={[]}
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={vi.fn()}
      onSelect={vi.fn()}
      onBack={vi.fn()}
      onSend={vi.fn()}
      onCreateGroup={vi.fn()}
      {...props}
    />,
  );
  return props;
};

describe('群管理入口', () => {
  it('群主能看到添加成员与修改群名', () => {
    view(OWNER);
    expect(screen.getByRole('button', { name: /添加/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /修改群名/ })).toBeInTheDocument();
  });

  it('系统管理员即使不是群主也能管理', () => {
    view(person('u_admin', '管理员', 'admin'));
    expect(screen.getByRole('button', { name: /添加/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /修改群名/ })).toBeInTheDocument();
  });

  it('普通成员看不到管理入口，但可以退群', () => {
    view(OTHER);
    expect(screen.queryByRole('button', { name: /添加/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /修改群名/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /退出群聊/ })).toBeInTheDocument();
  });

  it('群主和自己都不带移除按钮，其他人带', () => {
    view(OWNER);
    expect(screen.getByRole('button', { name: '将 陈子航 移出群聊' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '将 Aria 移出群聊' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '将 群主 移出群聊' })).not.toBeInTheDocument();
  });

  it('点移除会带上会话、成员 id 和名字回调上层', async () => {
    const props = view(OWNER);
    await userEvent.click(screen.getByRole('button', { name: '将 陈子航 移出群聊' }));
    expect(props.onRemoveMember).toHaveBeenCalledWith('c_room', 'u_other', '陈子航');
  });

  it('点添加/改名/退群分别触发对应回调', async () => {
    const props = view(OWNER);
    await userEvent.click(screen.getByRole('button', { name: /添加/ }));
    await userEvent.click(screen.getByRole('button', { name: /修改群名/ }));
    await userEvent.click(screen.getByRole('button', { name: /退出群聊/ }));
    expect(props.onAddMembers).toHaveBeenCalledWith('c_room');
    expect(props.onRenameGroup).toHaveBeenCalledWith('c_room', '发版协作');
    expect(props.onLeaveGroup).toHaveBeenCalledWith('c_room', '发版协作');
  });
});
