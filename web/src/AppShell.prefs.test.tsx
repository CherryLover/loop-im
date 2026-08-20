// AppShell 这一层负责把置顶 / 免打扰落库，并让列表立刻就位（不等一轮往返）。
// 失败要能回滚，而且无论成败都不许动未读 —— 免打扰不是「静音即已读」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiPublicInfo, Conversation, User } from './lib/types';

// useStream 会真的开 EventSource，jsdom 里没有；这组用例不靠 SSE，空掉即可。
vi.mock('./lib/useStream', () => ({ useStream: () => {} }));

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>();
  return { ...actual, api: mockApi };
});

const ME: User = {
  id: 'u_lin', name: '林悦', email: 'lin@loop.dev', dept: '产品',
  role: 'admin', avatarUrl: null, isAI: false, online: true,
};
const AI: AiPublicInfo = { name: 'Aria', providerLabel: '模拟供应商', silentRead: false, allowDm: true };

const convo = (id: string, title: string, at: number, over: Partial<Conversation> = {}): Conversation => ({
  id,
  type: 'group',
  title,
  peerId: null,
  createdBy: ME.id,
  members: [{ ...ME, roleInGroup: '管理员' }],
  lastMessage: { preview: '在吗', createdAt: at },
  unread: 0,
  ...over,
});

const API_METHODS = [
  'conversations', 'users', 'me', 'ping', 'messages', 'markRead', 'sendMessage',
  'aiContext', 'updateConversationPrefs', 'searchMessages',
] as const;
const mockApi = Object.fromEntries(API_METHODS.map((k) => [k, vi.fn()])) as
  Record<(typeof API_METHODS)[number], ReturnType<typeof vi.fn>>;

/** 列表里当前显示的会话标题，按屏幕上的先后顺序。 */
const titlesInOrder = () =>
  Array.from(document.querySelectorAll('.convos__list .convo__title')).map((el) => el.textContent);

async function mount(list: Conversation[]) {
  mockApi.conversations.mockResolvedValue({ conversations: list });
  const { AppShell } = await import('./AppShell');
  render(
    <AppShell me={ME} ai={AI} theme="light" onToggleTheme={vi.fn()} onSignOut={vi.fn()} justSignedIn={false} />,
  );
  await waitFor(() => expect(mockApi.conversations).toHaveBeenCalled());
  // 标题在列表和聊天详情各出现一次，取全部即可
  await screen.findAllByText(list[0].title);
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset().mockResolvedValue({});
  mockApi.conversations.mockResolvedValue({ conversations: [] });
  mockApi.users.mockResolvedValue({ users: [ME] });
  mockApi.me.mockResolvedValue({ user: ME, ai: AI });
  mockApi.ping.mockResolvedValue({ online: true, users: [ME] });
  mockApi.aiContext.mockResolvedValue({ line: '' });
  mockApi.markRead.mockResolvedValue({ conversationId: 'c_a', lastReadAt: 1, unread: 0 });
  mockApi.messages.mockResolvedValue({ messages: [], hasMore: false, nextBefore: null, reads: [] });
  vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('置顶落库', () => {
  it('点置顶就调接口，并且列表当场重排、不等下一轮拉取', async () => {
    await mount([convo('c_new', '最新的群', 300), convo('c_old', '很久没动的群', 100)]);
    expect(titlesInOrder()).toEqual(['最新的群', '很久没动的群']);

    await userEvent.click(screen.getByRole('button', { name: '置顶「很久没动的群」' }));

    expect(mockApi.updateConversationPrefs).toHaveBeenCalledWith('c_old', { pinned: true });
    // 接口还没重新拉过列表，顺序已经就位了
    await waitFor(() => expect(titlesInOrder()).toEqual(['很久没动的群', '最新的群']));
    expect(mockApi.conversations).toHaveBeenCalledTimes(1);
  });

  it('落库失败就把这一项还原，并提示', async () => {
    mockApi.updateConversationPrefs.mockRejectedValueOnce(new Error('网络错误'));
    await mount([convo('c_new', '最新的群', 300), convo('c_old', '很久没动的群', 100)]);

    await userEvent.click(screen.getByRole('button', { name: '置顶「很久没动的群」' }));

    await screen.findByText('网络错误');
    await waitFor(() => expect(titlesInOrder()).toEqual(['最新的群', '很久没动的群']));
    // 按钮也回到「还没置顶」的样子
    expect(screen.getByRole('button', { name: '置顶「很久没动的群」' })).toBeInTheDocument();
  });
});

describe('免打扰落库', () => {
  it('点免打扰调接口，且不碰未读 —— 免打扰不是「静音即已读」', async () => {
    // 标签页不可见，免得「打开会话即已读」把未读清零，盖住这里真正要看的东西。
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
    await mount([convo('c_a', '发版协作', 300, { unread: 4, mentionsUnread: 1 })]);
    expect(screen.getAllByLabelText('4 条未读，其中 1 条 @ 我').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: '免打扰「发版协作」' }));

    expect(mockApi.updateConversationPrefs).toHaveBeenCalledWith('c_a', { muted: true });
    // 徽标弱化了，但数字一个没少
    const list = document.querySelector('.convos__list') as HTMLElement;
    await waitFor(() => expect(within(list).getByLabelText('4 条未读，其中 1 条 @ 我')).toHaveTextContent('4'));
    expect(within(list).getByLabelText('4 条未读，其中 1 条 @ 我').className).toContain('badge--muted');
  });

  it('免打扰不参与排序，开了之后位置不变', async () => {
    await mount([convo('c_new', '最新的群', 300), convo('c_old', '旧的群', 100)]);
    await userEvent.click(screen.getByRole('button', { name: '免打扰「最新的群」' }));
    await waitFor(() => expect(mockApi.updateConversationPrefs).toHaveBeenCalled());
    expect(titlesInOrder()).toEqual(['最新的群', '旧的群']);
  });

  it('只改 muted 不会把 pinned 顺手改掉', async () => {
    await mount([convo('c_a', '发版协作', 300, { pinned: true })]);
    await userEvent.click(screen.getByRole('button', { name: '免打扰「发版协作」' }));
    expect(mockApi.updateConversationPrefs).toHaveBeenCalledWith('c_a', { muted: true });
    await waitFor(() => expect(screen.getAllByLabelText('已置顶').length).toBeGreaterThan(0));
  });
});
