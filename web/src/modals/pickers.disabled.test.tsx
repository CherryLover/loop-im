// 停用的账号不该出现在「建群 / 添加成员」的可选名单里——他登不进来，
// 拉进去只会多一个永远不说话的人。但已经在群里的停用成员照常留在成员列表，
// 那是历史，不能动。
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CreateGroupModal } from './CreateGroupModal';
import { ManageGroupModal } from './ManageGroupModal';
import type { Conversation, GroupMember, User } from '../lib/types';

vi.mock('../lib/api', () => ({ api: { createGroup: vi.fn(), addMembers: vi.fn() } }));

const person = (id: string, name: string, extra: Partial<User> = {}): User => ({
  id, name, email: `${id}@loop.dev`, dept: '产品',
  role: 'member', avatarUrl: null, isAI: false, online: true, ...extra,
});

const ME = person('u_me', '我');
const CHEN = person('u_chen', '陈子航');
const GONE = person('u_gone', '周离职', { disabled: true, online: false });
const ARIA = person('ai', 'Aria', { role: 'ai', isAI: true });

describe('建群的可选名单', () => {
  it('停用的人不出现在可选名单里，正常成员照常', () => {
    render(
      <CreateGroupModal users={[ME, CHEN, GONE, ARIA]} meId={ME.id} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    expect(screen.getByText('陈子航')).toBeInTheDocument();
    expect(screen.queryByText('周离职')).not.toBeInTheDocument();
    // 自己和 AI 本来就不在名单里，这里顺带确认没被改坏
    expect(screen.queryByText('我')).not.toBeInTheDocument();
    expect(screen.queryByText('Aria')).not.toBeInTheDocument();
  });
});

const asMember = (u: User, roleInGroup = '产品'): GroupMember => ({ ...u, roleInGroup });

const conversation = (members: GroupMember[]): Conversation => ({
  id: 'c_1', type: 'group', title: '交接群', peerId: null, createdBy: ME.id,
  members, lastMessage: null, unread: 0,
});

describe('添加群成员的可选名单', () => {
  it('停用的人不出现在可选名单里', () => {
    render(
      <ManageGroupModal
        mode="add"
        conversation={conversation([asMember(ME)])}
        users={[ME, CHEN, GONE]}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByText('陈子航')).toBeInTheDocument();
    expect(screen.queryByText('周离职')).not.toBeInTheDocument();
  });

  it('已经在群里的停用成员不受影响：他只是不在「可添加」这一栏里', () => {
    // 群成员列表由 ChatPage 渲染，这里能验的是弹窗不会把他当成「还能再加一次」的人。
    render(
      <ManageGroupModal
        mode="add"
        conversation={conversation([asMember(ME), asMember(GONE)])}
        users={[ME, GONE]}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByText('所有人都已经在群里了。')).toBeInTheDocument();
  });
});
