// 某个人被停用之后，他在别人界面上的样子。定下来的行为是：
// 私聊会话照常留在列表里，标题、头像、历史一字不动，只在对方那一侧标「已停用」。
// 不隐藏、不改标题、不变成「未知用户」——会话是双方共有的历史，藏起来只会让人
// 以为聊天记录被删了，而停用的全部意义恰恰是「不是删除」。
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ChatPage } from './ChatPage';
import type { Conversation, GroupMember, Message, User } from '../lib/types';

// 这里只看渲染，搜索和 AI 上下文那两个后台请求一律挡掉；
// 其余导出（Composer 要的 MAX_UPLOAD_MB 等）保留真身。
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      searchMessages: vi.fn().mockResolvedValue({ query: '', results: [], hasMore: false, nextBefore: null }),
      // 一直挂着不 resolve：这几个用例只看渲染，不想让一个迟到的 setState 在断言之后才落地。
      aiContext: vi.fn(() => new Promise<{ line: string }>(() => {})),
    },
  };
});

const person = (id: string, name: string, extra: Partial<User> = {}): User => ({
  id, name, email: `${id}@loop.dev`, dept: '产品',
  role: 'member', avatarUrl: null, isAI: false, online: true, ...extra,
});

const ME = person('u_me', '我');
const GONE = person('u_gone', '周离职', { disabled: true, online: false });
const HERE = person('u_here', '陈子航');
const ARIA = person('ai', 'Aria', { role: 'ai', isAI: true });

const asMember = (u: User): GroupMember => ({ ...u, roleInGroup: u.dept });

const dm = (peer: User): Conversation => ({
  id: `c_${peer.id}`,
  type: 'dm',
  title: peer.name,
  peerId: peer.id,
  createdBy: ME.id,
  members: [ME, peer].map(asMember),
  lastMessage: { preview: '离职前的最后一条', createdAt: 1_700_000_000_000 },
  unread: 0,
});

const message = (sender: User, body: string): Message => ({
  id: `m_${sender.id}`,
  conversationId: `c_${sender.id}`,
  senderId: sender.id,
  senderName: sender.name,
  senderAvatarUrl: null,
  body,
  mentions: [],
  createdAt: 1_700_000_000_000,
  isAI: false,
});

const view = (conversations: Conversation[], activeId: string, messages: Message[] = []) => {
  render(
    <ChatPage
      me={ME}
      conversations={conversations}
      activeId={activeId}
      messages={messages}
      typing={false}
      aiProviderLabel="模拟供应商"
      silentRead={false}
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
      onAddMembers={vi.fn()}
      onRemoveMember={vi.fn()}
      onRenameGroup={vi.fn()}
      onLeaveGroup={vi.fn()}
    />,
  );
};

describe('停用的人在别人会话列表里的样子', () => {
  it('私聊会话照常留在列表里，标题仍是他的名字，最后一条消息也还在', () => {
    view([dm(GONE)], 'c_u_gone');
    const list = document.querySelector('.convos__list') as HTMLElement;
    expect(within(list).getByText('周离职')).toBeInTheDocument();
    expect(within(list).getByText('离职前的最后一条')).toBeInTheDocument();
  });

  it('会话行上标出「已停用」，不用点进去才知道', () => {
    view([dm(GONE)], 'c_u_gone');
    const list = document.querySelector('.convos__list') as HTMLElement;
    expect(within(list).getByText('已停用')).toBeInTheDocument();
  });

  it('没被停用的人不会平白多出这个标记', () => {
    view([dm(HERE)], 'c_u_here');
    const list = document.querySelector('.convos__list') as HTMLElement;
    expect(within(list).queryByText('已停用')).not.toBeInTheDocument();
  });

  it('打开这个会话，头部如实说明对方账号已停用，历史消息照常渲染', () => {
    view([dm(GONE)], 'c_u_gone', [message(GONE, '交接文档我放在共享盘了')]);
    expect(screen.getByText('对方账号已停用')).toBeInTheDocument();
    expect(screen.getByText('交接文档我放在共享盘了')).toBeInTheDocument();
  });
});

describe('停用的人在群成员列表里的样子', () => {
  const room = (): Conversation => ({
    id: 'c_room', type: 'group', title: '交接群', peerId: null, createdBy: ME.id,
    members: [ME, GONE, HERE, ARIA].map(asMember),
    lastMessage: null, unread: 0,
  });

  it('不会被踢出群：名字照常出现在成员列表里，只是多一个「已停用」标记', () => {
    view([room()], 'c_room');
    const members = document.querySelector('.members') as HTMLElement;
    expect(within(members).getByText('周离职')).toBeInTheDocument();
    expect(within(members).getByText('已停用')).toBeInTheDocument();
    // 在职的人和 AI 都不该被误标
    expect(within(members).getAllByText('已停用')).toHaveLength(1);
  });

  it('他发过的消息照常显示他的名字，不会退化成「未知用户」', () => {
    view([room()], 'c_room', [message(GONE, '发版流程见 wiki 第三节')]);
    const list = document.querySelector('.msgs') || document.body;
    expect(within(list as HTMLElement).getByText('发版流程见 wiki 第三节')).toBeInTheDocument();
    expect(screen.getAllByText('周离职').length).toBeGreaterThan(0);
  });
});
