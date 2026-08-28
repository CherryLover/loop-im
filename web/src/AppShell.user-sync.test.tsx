// 改了名字或头像之后，界面上所有地方都要跟着变。
//
// 原来 SSE 的 `user-updated` 只会 `refreshUsers()`，可头像和名字在会话列表、会话详情的
// 成员栏、已加载消息上各有一份**拷贝**（conversation.members[]、message.senderName /
// senderAvatarUrl），refreshUsers 碰不到它们，于是联系人页变了、聊天这边还是旧的。
//
// 这组用例从事件进来的那一端一直断到 DOM：收到 user-updated，会话列表里那个人的头像 URL
// 和名字确实变了；同时钉住「不许靠整份重拉糊过去」——会话列表和消息一次都不能被重拉。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StreamHandlers } from './lib/useStream';
import type { Conversation, Message, User } from './lib/types';

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
  role: 'member', avatarUrl: '/uploads/old-avatar.png',
};
/** 换了头像 key 就变（对象名是 randomUUID），所以新旧是两个不同的 URL。 */
const RENAMED: User = { ...PEER, name: '陈子航（新）', avatarUrl: '/uploads/new-avatar.png' };

const GROUP: Conversation = {
  id: 'c_group',
  type: 'group',
  title: '发版协作',
  peerId: null,
  createdBy: ME.id,
  members: [ME, PEER].map((m) => ({ ...m, roleInGroup: m.id === ME.id ? '管理员' : m.dept })),
  lastMessage: { preview: '在吗', createdAt: 300 },
  unread: 0,
};
const DM: Conversation = {
  ...GROUP,
  id: 'c_dm',
  type: 'dm',
  title: PEER.name,
  peerId: PEER.id,
  lastMessage: { preview: '在吗', createdAt: 100 },
};

const MESSAGE: Message = {
  id: 'm1',
  conversationId: 'c_group',
  senderId: PEER.id,
  senderName: PEER.name,
  senderAvatarUrl: PEER.avatarUrl,
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

/** 某个区域里那张头像的 `src`（<Avatar> 渲染成 <img alt={名字}>）。 */
const avatarSrcIn = (selector: string, alt: string) =>
  within(document.querySelector(selector) as HTMLElement).getByAltText(alt).getAttribute('src');

const listTitles = () =>
  Array.from(document.querySelectorAll('.convos__list .convo__title')).map((el) => el.textContent);

async function mount(conversations: Conversation[] = [DM, GROUP]) {
  mockApi.conversations.mockResolvedValue({ conversations });
  const { AppShell } = await import('./AppShell');
  render(
    <AppShell me={ME} theme="light" onToggleTheme={vi.fn()} onSignOut={vi.fn()} justSignedIn={false} />,
  );
  await waitFor(() => expect(mockApi.conversations).toHaveBeenCalled());
  await screen.findAllByText(conversations[0].title);
}

beforeEach(() => {
  handlers = {};
  for (const fn of Object.values(mockApi)) fn.mockReset().mockResolvedValue({});
  mockApi.conversations.mockResolvedValue({ conversations: [] });
  mockApi.users.mockResolvedValue({ users: [ME, PEER] });
  mockApi.me.mockResolvedValue({ user: ME });
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

describe('收到 user-updated：界面上那几份拷贝一起对齐', () => {
  it('会话列表里那个人的头像 URL 和名字确实变了', async () => {
    await mount();
    expect(avatarSrcIn('.convos__list', '陈子航')).toBe('/uploads/old-avatar.png');
    expect(listTitles()).toContain('陈子航');

    await act(async () => { handlers.onUserChanged?.(RENAMED); });

    await waitFor(() => expect(avatarSrcIn('.convos__list', '陈子航（新）')).toBe('/uploads/new-avatar.png'));
    expect(listTitles()).toContain('陈子航（新）');
    expect(listTitles()).not.toContain('陈子航');
  });

  it('会话详情的成员列表跟着变', async () => {
    await mount([GROUP]);
    expect(avatarSrcIn('.members', '陈子航')).toBe('/uploads/old-avatar.png');

    await act(async () => { handlers.onUserChanged?.(RENAMED); });

    await waitFor(() => expect(avatarSrcIn('.members', '陈子航（新）')).toBe('/uploads/new-avatar.png'));
    const pane = document.querySelector('.members') as HTMLElement;
    expect(within(pane).getByText('陈子航（新）')).toBeInTheDocument();
    // 群里的身份是「在这个群里」的，不该被个人资料覆盖掉
    expect(within(pane).getByText('后端')).toBeInTheDocument();
  });

  it('已加载消息上的发送者名字和头像也跟着变', async () => {
    await mount([GROUP]);
    await waitFor(() => expect(avatarSrcIn('.chat__scroll','陈子航')).toBe('/uploads/old-avatar.png'));

    await act(async () => { handlers.onUserChanged?.(RENAMED); });

    await waitFor(() => expect(avatarSrcIn('.chat__scroll','陈子航（新）')).toBe('/uploads/new-avatar.png'));
  });

  it('联系人页那一份同样是新的', async () => {
    await mount();
    // 「联系人」在侧栏和底部 tabbar 各有一个入口，点哪个都一样。
    await userEvent.click(screen.getAllByRole('button', { name: '联系人' })[0]);
    await screen.findByText('陈子航');

    await act(async () => { handlers.onUserChanged?.(RENAMED); });

    await screen.findByText('陈子航（新）');
  });
});

describe('最小更新范围：不许靠整份重拉糊过去', () => {
  it('改名不会重拉会话列表，也不会重拉消息', async () => {
    await mount();
    await waitFor(() => expect(mockApi.messages).toHaveBeenCalled());
    const conversationCalls = mockApi.conversations.mock.calls.length;
    const messageCalls = mockApi.messages.mock.calls.length;

    await act(async () => { handlers.onUserChanged?.(RENAMED); });

    await waitFor(() => expect(listTitles()).toContain('陈子航（新）'));
    expect(mockApi.conversations).toHaveBeenCalledTimes(conversationCalls);
    expect(mockApi.messages).toHaveBeenCalledTimes(messageCalls);
  });

  it('名单里已经有这个人时，连联系人列表都不用重拉', async () => {
    await mount();
    await waitFor(() => expect(mockApi.users).toHaveBeenCalled());
    const userCalls = mockApi.users.mock.calls.length;

    await act(async () => { handlers.onUserChanged?.(RENAMED); });

    await waitFor(() => expect(listTitles()).toContain('陈子航（新）'));
    expect(mockApi.users).toHaveBeenCalledTimes(userCalls);
  });

  it('新开通的账号（user-created 走同一个回调）名单里还没有，这时才重拉一次', async () => {
    await mount();
    await waitFor(() => expect(mockApi.users).toHaveBeenCalled());
    const userCalls = mockApi.users.mock.calls.length;

    const stranger: User = { ...PEER, id: 'u_new', name: '新同事', avatarUrl: null };
    await act(async () => { handlers.onUserChanged?.(stranger); });

    await waitFor(() => expect(mockApi.users).toHaveBeenCalledTimes(userCalls + 1));
  });
});

describe('改名的人自己那一侧', () => {
  it('在个人资料里改完，会话详情的成员列表当场就是新名字，且不重拉会话', async () => {
    await mount([GROUP]);
    mockApi.updateName.mockResolvedValue({ user: { ...ME, name: '林悦悦' } });
    const conversationCalls = mockApi.conversations.mock.calls.length;

    // 侧栏那个头像按钮的可及名字是首字母，不是 title，所以按 title 找。
    await userEvent.click(screen.getByTitle('个人资料'));
    const nickname = await screen.findByLabelText('昵称');
    await userEvent.clear(nickname);
    await userEvent.type(nickname, '林悦悦');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockApi.updateName).toHaveBeenCalledWith('林悦悦'));
    const pane = document.querySelector('.members') as HTMLElement;
    await waitFor(() => expect(within(pane).getByText('林悦悦')).toBeInTheDocument());
    expect(mockApi.conversations).toHaveBeenCalledTimes(conversationCalls);
  });

  it('别的标签页改的名字，从 SSE 绕回来时自己这边也认', async () => {
    await mount([GROUP]);
    await act(async () => { handlers.onUserChanged?.({ ...ME, name: '林悦悦' }); });

    const pane = document.querySelector('.members') as HTMLElement;
    await waitFor(() => expect(within(pane).getByText('林悦悦')).toBeInTheDocument());
  });
});
