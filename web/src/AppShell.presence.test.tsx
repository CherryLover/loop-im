// 「在线 / 离线」的小圆点和文字不能过时。
//
// 在线状态在前端有**两份**拷贝：联系人名单（users）和会话成员（conversations[].members）。
// ContactsPage 读前者，ChatPage 的顶栏文字、顶栏圆点、群成员圆点读的都是后者。原来两条路
// 都只喂前者，于是聊天这边的点一直停在打开页面那一刻的样子：
//
// - 路径 A：SSE 的 presence 事件被接成 `() => refreshUsers()`，userId / online 两个参数
//   全丢了，重拉回来的名单也只写进 users；
// - 路径 B：关掉标签页就走人这种下线**服务端不发任何事件**（只在登录 / 退出 / 停用时广播），
//   唯一能发现它的是 45 秒一轮的心跳，而心跳同样只写 users。
//
// 这组用例从两条路各自的入口一直断到 DOM 上那个点，顺带钉住「不许靠重拉糊过去」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StreamHandlers } from './lib/useStream';
import type { AiPublicInfo, Conversation, Message, User } from './lib/types';

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
  role: 'admin', avatarUrl: null, isAI: false, online: true, disabled: false,
};
const PEER: User = {
  ...ME, id: 'u_chen', name: '陈子航', email: 'c@loop.dev', dept: '后端',
  role: 'member', avatarUrl: null,
};
const AI: AiPublicInfo = { name: 'Aria', providerLabel: '模拟供应商', silentRead: false, allowDm: true };

const groupWith = (...members: User[]): Conversation => ({
  id: 'c_group',
  type: 'group',
  title: '发版协作',
  peerId: null,
  createdBy: ME.id,
  members: members.map((m) => ({ ...m, roleInGroup: m.id === ME.id ? '管理员' : m.dept })),
  lastMessage: { preview: '在吗', createdAt: 300 },
  unread: 0,
});
const GROUP = groupWith(ME, PEER);
const DM: Conversation = { ...GROUP, id: 'c_dm', type: 'dm', title: PEER.name, peerId: PEER.id };

const MESSAGE: Message = {
  id: 'm1',
  conversationId: 'c_group',
  senderId: PEER.id,
  senderName: PEER.name,
  senderAvatarUrl: null,
  body: '我先发一条',
  mentions: [],
  createdAt: 1_700_000_000_000,
  isAI: false,
};

const API_METHODS = [
  'conversations', 'users', 'me', 'ping', 'messages', 'markRead', 'sendMessage',
  'aiContext', 'searchMessages', 'updateName', 'uploadAvatar', 'changePassword',
] as const;
const mockApi = Object.fromEntries(API_METHODS.map((k) => [k, vi.fn()])) as
  Record<(typeof API_METHODS)[number], ReturnType<typeof vi.fn>>;

/** 会话顶栏那一行：「在线 / 离线 / 对方账号已停用」。 */
const headerText = () => document.querySelector('.chat__sub')?.textContent?.trim();
/** 顶栏那个圆点是亮的还是灰的（dot--online / dot--offline）。 */
const headerDot = () => document.querySelector('.chat__sub .dot')?.className;
/** 群成员列表里某个人头像上的点：亮着是 var(--calm)，灭了是 var(--faint)。 */
const memberDot = (name: string) => {
  const row = Array.from(document.querySelectorAll('.members__row'))
    .find((el) => el.querySelector('.members__name')?.textContent === name);
  return row?.querySelector('.avatar__dot')?.getAttribute('style');
};
const ONLINE_DOT = 'background: var(--calm);';
const OFFLINE_DOT = 'background: var(--faint);';
/** 联系人页那一行的「在线 / 离线」。 */
const contactStatus = (name: string) => {
  const row = Array.from(document.querySelectorAll('.contact'))
    .find((el) => el.querySelector('.contact__name')?.textContent === name);
  return row?.querySelector('.contact__status')?.textContent?.trim();
};

async function mount(conversations: Conversation[]) {
  mockApi.conversations.mockResolvedValue({ conversations });
  const { AppShell } = await import('./AppShell');
  render(
    <AppShell me={ME} ai={AI} theme="light" onToggleTheme={vi.fn()} onSignOut={vi.fn()} justSignedIn={false} />,
  );
  await waitFor(() => expect(mockApi.conversations).toHaveBeenCalled());
  await screen.findAllByText(conversations[0].title);
}

beforeEach(() => {
  handlers = {};
  for (const fn of Object.values(mockApi)) fn.mockReset().mockResolvedValue({});
  mockApi.conversations.mockResolvedValue({ conversations: [] });
  mockApi.users.mockResolvedValue({ users: [ME, PEER] });
  mockApi.me.mockResolvedValue({ user: ME, ai: AI });
  mockApi.ping.mockResolvedValue({ online: true, users: [ME, PEER] });
  mockApi.aiContext.mockResolvedValue({ line: '' });
  mockApi.markRead.mockResolvedValue({ conversationId: 'c_dm', lastReadAt: 1, unread: 0 });
  mockApi.messages.mockResolvedValue({ messages: [MESSAGE], hasMore: false, nextBefore: null, reads: [] });
  vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(false);
});
afterEach(() => {
  // 必须先卸载再还原 mock：反过来的话，残留组件在卸载期间跑的 effect
  // 会拿到已被清空的桩，抛出与本用例无关的错误。
  cleanup();
  vi.restoreAllMocks();
});

describe('路径 A：收到 presence，聊天这边的在线状态当场跟着变', () => {
  it('单聊顶栏的文字和圆点一起变', async () => {
    await mount([DM]);
    expect(headerText()).toBe('在线');
    expect(headerDot()).toContain('dot--online');

    await act(async () => { handlers.onPresence?.(PEER.id, false); });

    await waitFor(() => expect(headerText()).toBe('离线'));
    expect(headerDot()).toContain('dot--offline');
  });

  it('重新上线也认得', async () => {
    await mount([DM]);
    await act(async () => { handlers.onPresence?.(PEER.id, false); });
    await waitFor(() => expect(headerText()).toBe('离线'));

    await act(async () => { handlers.onPresence?.(PEER.id, true); });

    await waitFor(() => expect(headerText()).toBe('在线'));
  });

  it('群成员列表里那个人的点跟着灭', async () => {
    await mount([GROUP]);
    expect(memberDot('陈子航')).toBe(ONLINE_DOT);

    await act(async () => { handlers.onPresence?.(PEER.id, false); });

    await waitFor(() => expect(memberDot('陈子航')).toBe(OFFLINE_DOT));
  });

  it('联系人页那一份同样是新的（两份拷贝都要改，不是二选一）', async () => {
    await mount([GROUP]);
    await act(async () => { handlers.onPresence?.(PEER.id, false); });
    await waitFor(() => expect(memberDot('陈子航')).toBe(OFFLINE_DOT));

    // 「联系人」在侧栏和底部 tabbar 各有一个入口，点哪个都一样。
    await userEvent.click(screen.getAllByRole('button', { name: '联系人' })[0]);

    await waitFor(() => expect(contactStatus('陈子航')).toBe('离线'));
  });

  it('已停用的账号不会被一条 presence 重新点亮', async () => {
    const gone: User = { ...PEER, online: false, disabled: true };
    await mount([groupWith(ME, gone)]);
    expect(memberDot('陈子航')).toBe(OFFLINE_DOT);

    await act(async () => { handlers.onPresence?.(gone.id, true); });

    await waitFor(() => expect(screen.getAllByText('已停用').length).toBeGreaterThan(0));
    expect(memberDot('陈子航')).toBe(OFFLINE_DOT);
  });

  it('自己不由广播说了算：别的设备退出登录时，我这一端还亮着', async () => {
    await mount([GROUP]);
    expect(memberDot('林悦')).toBe(ONLINE_DOT);

    await act(async () => { handlers.onPresence?.(ME.id, false); });

    // 这个客户端正开着、每 45 秒还在心跳，把自己点灭只会是自相矛盾。
    expect(memberDot('林悦')).toBe(ONLINE_DOT);
  });

  it('不为一条 presence 重拉任何东西：联系人、会话列表、消息一个都不许多请求', async () => {
    await mount([GROUP]);
    await waitFor(() => expect(mockApi.messages).toHaveBeenCalled());
    const userCalls = mockApi.users.mock.calls.length;
    const conversationCalls = mockApi.conversations.mock.calls.length;
    const messageCalls = mockApi.messages.mock.calls.length;

    await act(async () => { handlers.onPresence?.(PEER.id, false); });

    // 先查请求次数再查 DOM：改回「收到就重拉一次 /users」的老实现时，第一个红的
    // 就是这一条，而不是后面那个点的颜色。
    expect(mockApi.users).toHaveBeenCalledTimes(userCalls);
    expect(mockApi.conversations).toHaveBeenCalledTimes(conversationCalls);
    expect(mockApi.messages).toHaveBeenCalledTimes(messageCalls);
    await waitFor(() => expect(memberDot('陈子航')).toBe(OFFLINE_DOT));
  });
});

describe('路径 B：关掉浏览器没有任何事件，靠心跳发现', () => {
  // 心跳是 45 秒一轮，只能拨快时钟。计时器要在挂载**之前**换掉，
  // 否则那个 setInterval 已经挂在真实时钟上，拨谁都没用。
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** 假计时器下不能用 waitFor（它自己也要计时）：Promise 是微任务，冲一轮就够。 */
  const flush = () => act(async () => { await Promise.resolve(); });

  async function mountFrozen(conversations: Conversation[]) {
    mockApi.conversations.mockResolvedValue({ conversations });
    const { AppShell } = await import('./AppShell');
    render(
      <AppShell me={ME} ai={AI} theme="light" onToggleTheme={vi.fn()} onSignOut={vi.fn()} justSignedIn={false} />,
    );
    await flush();
    await flush();
  }

  it('对方直接关掉标签页：一轮心跳之后，群成员列表里他的点灭了', async () => {
    await mountFrozen([GROUP]);
    expect(memberDot('陈子航')).toBe(ONLINE_DOT);

    // 服务端这边 last_seen_at 过了 90 秒窗口，于是心跳返回的名单里他成了离线。
    // 注意全程没有任何 presence 事件 —— 这一路只有心跳能发现。
    mockApi.ping.mockResolvedValue({ online: true, users: [ME, { ...PEER, online: false }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });

    expect(mockApi.ping).toHaveBeenCalled();
    expect(memberDot('陈子航')).toBe(OFFLINE_DOT);
  });

  it('单聊顶栏同样跟着心跳走，而且不为此多发一个请求', async () => {
    await mountFrozen([DM]);
    expect(headerText()).toBe('在线');
    const userCalls = mockApi.users.mock.calls.length;
    const conversationCalls = mockApi.conversations.mock.calls.length;

    mockApi.ping.mockResolvedValue({ online: true, users: [ME, { ...PEER, online: false }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });

    expect(headerText()).toBe('离线');
    expect(headerDot()).toContain('dot--offline');
    // 心跳返回的名单里已经有全员的在线状态，会话成员就地改就行。
    expect(mockApi.users).toHaveBeenCalledTimes(userCalls);
    expect(mockApi.conversations).toHaveBeenCalledTimes(conversationCalls);
  });

  it('人又回来了，心跳也照样把点重新点亮', async () => {
    await mountFrozen([GROUP]);
    mockApi.ping.mockResolvedValue({ online: true, users: [ME, { ...PEER, online: false }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(memberDot('陈子航')).toBe(OFFLINE_DOT);

    mockApi.ping.mockResolvedValue({ online: true, users: [ME, PEER] });
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });

    expect(memberDot('陈子航')).toBe(ONLINE_DOT);
  });
});
