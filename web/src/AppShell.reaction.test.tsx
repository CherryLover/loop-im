// 表情回应的整条链路：气泡下方选一个表情 → 调加/取消接口 → 用服务端给的聚合刷新气泡；
// 别人点的回应从 SSE 推过来，我这边不刷新也要跟着变。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StreamHandlers } from './lib/useStream';
import type { Conversation, Message, MessageReaction, User } from './lib/types';

// useStream 会真的开 EventSource，jsdom 里没有；换成把回调存下来，测试自己触发。
let handlers: StreamHandlers = {};
vi.mock('./lib/useStream', () => ({
  useStream: (_enabled: boolean, h: StreamHandlers) => { handlers = h; },
}));

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>();
  return { ...actual, api: mockApi };
});

const ME: User = {
  id: 'u_lin', name: '林悦', email: 'lin@loop.dev', dept: '产品',
  role: 'admin', avatarUrl: null, isAI: false, online: true,
};
const PEER: User = { ...ME, id: 'u_chen', name: '陈子航', email: 'c@loop.dev', dept: '后端', role: 'member' };

const conversation: Conversation = {
  id: 'c1',
  type: 'group',
  title: '发版协作',
  peerId: null,
  createdBy: ME.id,
  members: [ME, PEER].map((m) => ({ ...m, roleInGroup: m.dept })),
  lastMessage: null,
  unread: 0,
};

const MESSAGE: Message = {
  id: 'm_1',
  conversationId: 'c1',
  senderId: PEER.id,
  senderName: PEER.name,
  senderAvatarUrl: null,
  body: '联调排期改到下周二',
  mentions: [],
  createdAt: 1_700_000_000_000,
  isAI: false,
  reactions: [],
};

const thumbsUp = (over: Partial<MessageReaction> = {}): MessageReaction => ({
  emoji: '👍', count: 1, users: [{ id: ME.id, name: ME.name }], mine: true, ...over,
});

const API_METHODS = [
  'conversations', 'users', 'me', 'ping', 'messages', 'markRead', 'sendMessage',
  'addMembers', 'removeMember', 'renameConversation', 'leaveConversation',
  'openDirect', 'createGroup', 'addUser', 'aiContext', 'updateName',
  'changePassword', 'upload', 'uploadAvatar', 'addReaction', 'removeReaction',
] as const;

const mockApi = Object.fromEntries(API_METHODS.map((k) => [k, vi.fn()])) as
  Record<(typeof API_METHODS)[number], ReturnType<typeof vi.fn>>;

async function mount(message: Message = MESSAGE) {
  mockApi.messages.mockResolvedValue({ messages: [message], hasMore: false, nextBefore: null, reads: [] });
  const { AppShell } = await import('./AppShell');
  render(
    <AppShell me={ME} theme="light" onToggleTheme={vi.fn()} onSignOut={vi.fn()} justSignedIn={false} />,
  );
  await waitFor(() => expect(screen.getByText('联调排期改到下周二')).toBeInTheDocument());
}

beforeEach(() => {
  handlers = {};
  for (const fn of Object.values(mockApi)) fn.mockReset().mockResolvedValue({});
  mockApi.conversations.mockResolvedValue({ conversations: [conversation] });
  mockApi.users.mockResolvedValue({ users: [ME, PEER] });
  mockApi.me.mockResolvedValue({ user: ME });
  mockApi.ping.mockResolvedValue({ online: true, users: [ME, PEER] });
  mockApi.aiContext.mockResolvedValue({ line: '' });
  mockApi.markRead.mockResolvedValue({ conversationId: 'c1', lastReadAt: 1, unread: 0 });
  vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(false);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('点表情回应', () => {
  it('从选表情的入口挑一个：调加接口，气泡下方立刻出现这个回应', async () => {
    mockApi.addReaction.mockResolvedValue({ messageId: 'm_1', reactions: [thumbsUp()] });
    await mount();

    await userEvent.click(screen.getByRole('button', { name: '添加表情回应' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '用 👍 回应' }));

    await waitFor(() => expect(mockApi.addReaction).toHaveBeenCalledWith('c1', 'm_1', '👍'));
    await waitFor(() => expect(screen.getByRole('button', { name: /👍 1 人，包括我/ })).toBeInTheDocument());
  });

  it('点自己已经点过的那个就是取消，走取消接口', async () => {
    mockApi.removeReaction.mockResolvedValue({ messageId: 'm_1', reactions: [] });
    await mount({ ...MESSAGE, reactions: [thumbsUp()] });

    await userEvent.click(screen.getByRole('button', { name: /👍 1 人，包括我/ }));

    await waitFor(() => expect(mockApi.removeReaction).toHaveBeenCalledWith('c1', 'm_1', '👍'));
    expect(mockApi.addReaction).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('button', { name: /👍/ })).not.toBeInTheDocument());
  });

  it('点别人点过、自己没点的那个是加上，不是取消', async () => {
    const others = thumbsUp({ users: [{ id: PEER.id, name: PEER.name }], mine: false });
    mockApi.addReaction.mockResolvedValue({
      messageId: 'm_1',
      reactions: [thumbsUp({ count: 2, users: [{ id: PEER.id, name: PEER.name }, { id: ME.id, name: ME.name }] })],
    });
    await mount({ ...MESSAGE, reactions: [others] });

    await userEvent.click(screen.getByRole('button', { name: '👍 1 人' }));

    await waitFor(() => expect(mockApi.addReaction).toHaveBeenCalledWith('c1', 'm_1', '👍'));
    expect(mockApi.removeReaction).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: /👍 2 人，包括我/ })).toBeInTheDocument());
  });

  it('接口失败时提示一句，气泡上的回应保持原样', async () => {
    mockApi.addReaction.mockRejectedValue(new Error('不支持的表情'));
    await mount();

    await userEvent.click(screen.getByRole('button', { name: '添加表情回应' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '用 🎉 回应' }));

    await waitFor(() => expect(screen.getByText('不支持的表情')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /🎉/ })).not.toBeInTheDocument();
  });
});

describe('别人点的回应实时进来', () => {
  it('SSE 推来 reaction，气泡下方跟着变，不用重新拉消息', async () => {
    await mount();
    expect(screen.queryByRole('button', { name: /🎉/ })).not.toBeInTheDocument();

    act(() => {
      handlers.onReaction?.('c1', 'm_1', [
        { emoji: '🎉', count: 1, users: [{ id: PEER.id, name: PEER.name }], mine: false },
      ]);
    });

    const chip = await screen.findByRole('button', { name: '🎉 1 人' });
    expect(chip).toHaveAttribute('title', '陈子航 点了 🎉');
    expect(mockApi.messages).toHaveBeenCalledTimes(1);      // 没有为此重新拉一页消息
  });

  it('推来的是空数组就是最后一个人取消了，回应整条消失', async () => {
    await mount({ ...MESSAGE, reactions: [thumbsUp()] });
    expect(screen.getByRole('button', { name: /👍 1 人/ })).toBeInTheDocument();

    act(() => { handlers.onReaction?.('c1', 'm_1', []); });

    await waitFor(() => expect(screen.queryByRole('button', { name: /👍/ })).not.toBeInTheDocument());
  });

  it('推来的消息不在已加载的列表里时安静忽略，不会凭空造出一条', async () => {
    await mount();

    act(() => {
      handlers.onReaction?.('c1', 'm_还没翻页出来的一条', [
        { emoji: '👍', count: 1, users: [{ id: PEER.id, name: PEER.name }], mine: false },
      ]);
    });

    await waitFor(() => expect(screen.getAllByText('联调排期改到下周二')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: /👍/ })).not.toBeInTheDocument();
  });
});
