// 侧栏与底部标签栏上的总徽标：除了总未读，还要能看出「有人 @ 我」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { StreamHandlers } from './lib/useStream';
import type { AiPublicInfo, Conversation, User } from './lib/types';

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
const AI: AiPublicInfo = { name: 'Aria', providerLabel: '模拟供应商', silentRead: false, allowDm: true };

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  type: 'group',
  title: '发版协作',
  peerId: null,
  createdBy: ME.id,
  members: [ME, PEER].map((m) => ({ ...m, roleInGroup: m.dept })),
  lastMessage: null,
  unread: 0,
  ...over,
});

const API_METHODS = [
  'conversations', 'users', 'me', 'ping', 'messages', 'markRead', 'sendMessage',
  'addMembers', 'removeMember', 'renameConversation', 'leaveConversation',
  'openDirect', 'createGroup', 'addUser', 'aiContext', 'updateName',
  'changePassword', 'upload', 'uploadAvatar',
] as const;

const mockApi = Object.fromEntries(API_METHODS.map((k) => [k, vi.fn()])) as
  Record<(typeof API_METHODS)[number], ReturnType<typeof vi.fn>>;

async function mount(conversations: Conversation[]) {
  mockApi.conversations.mockResolvedValue({ conversations });
  const { AppShell } = await import('./AppShell');
  render(
    <AppShell me={ME} ai={AI} theme="light" onToggleTheme={vi.fn()} onSignOut={vi.fn()} justSignedIn={false} />,
  );
  await waitFor(() => expect(mockApi.conversations).toHaveBeenCalled());
}

beforeEach(() => {
  handlers = {};
  for (const fn of Object.values(mockApi)) fn.mockReset().mockResolvedValue({});
  mockApi.conversations.mockResolvedValue({ conversations: [] });
  mockApi.users.mockResolvedValue({ users: [ME, PEER] });
  mockApi.me.mockResolvedValue({ user: ME, ai: AI });
  mockApi.ping.mockResolvedValue({ online: true, users: [ME, PEER] });
  mockApi.aiContext.mockResolvedValue({ line: '' });
  mockApi.markRead.mockResolvedValue({ conversationId: 'c1', lastReadAt: 1, unread: 0 });
  mockApi.messages.mockResolvedValue({ messages: [], hasMore: false, nextBefore: null, reads: [] });
  // 默认让页面处于「不可见」：否则打开首个会话会立刻上报已读并把未读清零，
  // 徽标断言就变成了和这次上报赛跑。需要走上报那条路的用例自己把它打开。
  vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('总徽标 · 有人 @ 我', () => {
  it('把各会话的「@ 我」加总，并在无障碍名称里点出来', async () => {
    await mount([
      conversation({ id: 'c1', unread: 3, mentionsUnread: 1 }),
      conversation({ id: 'c2', title: '另一个群', unread: 4, mentionsUnread: 2 }),
    ]);
    await waitFor(() =>
      expect(screen.getAllByLabelText('7 条未读，其中 3 条 @ 我').length).toBeGreaterThan(0));
  });

  it('一条 @ 都没有时，总徽标保持普通样式与原来的说法', async () => {
    await mount([
      conversation({ id: 'c1', unread: 3, mentionsUnread: 0 }),
      conversation({ id: 'c2', title: '另一个群', unread: 4 }),
    ]);
    const badges = await screen.findAllByLabelText('7 条未读');
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) expect(badge).not.toHaveClass('badge--mention');
  });

  it('有 @ 我时总徽标换成高亮样式（侧栏和底部标签栏都换）', async () => {
    // 两个会话：总数与任何单条都不重样，才好确认拿到的就是侧栏和标签栏那两个总徽标。
    await mount([
      conversation({ id: 'c1', unread: 2, mentionsUnread: 1 }),
      conversation({ id: 'c2', title: '另一个群', unread: 1, mentionsUnread: 1 }),
    ]);
    const badges = await screen.findAllByLabelText('3 条未读，其中 2 条 @ 我');
    expect(badges.length).toBe(2);
    for (const badge of badges) expect(badge).toHaveClass('badge', 'badge--mention');
  });

  it('打开会话上报已读后，高亮徽标随之消失', async () => {
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(false);
    await mount([conversation({ id: 'c1', unread: 2, mentionsUnread: 2 })]);
    await waitFor(() => expect(mockApi.markRead).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByLabelText(/条未读/)).not.toBeInTheDocument());
    expect(typeof handlers.onMessage).toBe('function');   // SSE 回调仍在注册，没被这次改动带偏
  });
});
