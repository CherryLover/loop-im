// 服务端限流（429）之后的完整链路：
//   1. 提示里要说清「几点几分可以再发」——钟点在本地由 retryAfterMs 换算；
//   2. 用户打的字必须还在输入框里。第一波做的「发送失败恢复草稿」正好接住这种失败，
//      这里把这条链路钉住：以后谁把 429 单独截成「静默失败」，这个用例就会红。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Conversation, Message, User } from './lib/types';

// useStream 会真的开 EventSource，jsdom 里没有。这里的用例都不依赖推送，空实现即可。
vi.mock('./lib/useStream', () => ({ useStream: () => {} }));

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>();
  return { ...actual, api: mockApi };
});

const ME: User = {
  id: 'u_lin', name: '林悦', email: 'lin@loop.dev', dept: '产品',
  role: 'admin', avatarUrl: null, isAI: false, online: true,
};
const PEER: User = { ...ME, id: 'u_chen', name: '陈子航', email: 'c@loop.dev', dept: '后端', role: 'member' };

const CONVERSATION: Conversation = {
  id: 'c1',
  type: 'group',
  title: '发版协作',
  peerId: null,
  createdBy: ME.id,
  members: [ME, PEER].map((m) => ({ ...m, roleInGroup: m.dept })),
  lastMessage: null,
  unread: 0,
};

const EXISTING: Message = {
  id: 'm1',
  conversationId: 'c1',
  senderId: PEER.id,
  senderName: PEER.name,
  senderAvatarUrl: null,
  body: '接口今晚能好',
  mentions: [],
  createdAt: 1_700_000_000_000,
  isAI: false,
};

const API_METHODS = [
  'conversations', 'users', 'me', 'ping', 'messages', 'markRead', 'sendMessage',
  'addMembers', 'removeMember', 'renameConversation', 'leaveConversation',
  'openDirect', 'createGroup', 'addUser', 'aiContext', 'updateName',
  'changePassword', 'upload', 'uploadAvatar',
] as const;

const mockApi = Object.fromEntries(API_METHODS.map((k) => [k, vi.fn()])) as
  Record<(typeof API_METHODS)[number], ReturnType<typeof vi.fn>>;

async function mount() {
  mockApi.conversations.mockResolvedValue({ conversations: [CONVERSATION] });
  const { AppShell } = await import('./AppShell');
  render(
    <AppShell me={ME} theme="light" onToggleTheme={vi.fn()} onSignOut={vi.fn()} justSignedIn={false} />,
  );
  await waitFor(() => expect(mockApi.conversations).toHaveBeenCalled());
  return screen.findByPlaceholderText(/输入消息/) as Promise<HTMLTextAreaElement>;
}

/** 服务端限流时 api 层抛出来的东西：429 + 相对毫秒 + 服务端此刻。 */
async function rateLimited(retryAfterMs: number, text = '消息发得太快了，请稍后再试') {
  const { ApiError } = await import('./lib/api');
  return new ApiError(429, text, { retryAfterMs, serverNow: Date.now() });
}

beforeEach(() => {
  // 全部桩先给一个安全默认值：返回 undefined 会让组件里的 .then 抛无关的 TypeError，
  // 把真正的断言掩盖掉。
  for (const fn of Object.values(mockApi)) fn.mockReset().mockResolvedValue({});
  mockApi.conversations.mockResolvedValue({ conversations: [] });
  mockApi.users.mockResolvedValue({ users: [ME, PEER] });
  mockApi.me.mockResolvedValue({ user: ME });
  mockApi.ping.mockResolvedValue({ online: true, users: [ME, PEER] });
  mockApi.aiContext.mockResolvedValue({ line: '' });
  mockApi.markRead.mockResolvedValue({ conversationId: 'c1', lastReadAt: 1, unread: 0 });
  mockApi.messages.mockResolvedValue({ messages: [EXISTING], hasMore: false, nextBefore: null, reads: [] });
  vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('被限流之后', () => {
  it('提示里说得出几点几分可以再发', async () => {
    mockApi.sendMessage.mockRejectedValue(await rateLimited(60_000));
    const input = await mount();
    const user = userEvent.setup();

    await user.type(input, '发版时间定了吗');
    await user.keyboard('{Enter}');

    const toast = await screen.findByRole('status');
    // 钟点由本地的 Date.now() + retryAfterMs 算出来，所以只断言形态和文案，
    // 精确换算另有 lib/format.rate-limit.test.ts 用固定时刻钉住。
    expect(toast.textContent).toMatch(/消息发得太快了/);
    expect(toast.textContent).toMatch(/\d{2}:\d{2} 后可以再发/);
  });

  it('用户打的字还在输入框里，「发送」按钮也没被卡成禁用', async () => {
    mockApi.sendMessage.mockRejectedValue(await rateLimited(60_000));
    const input = await mount();
    const user = userEvent.setup();

    await user.type(input, '联调排期改到下周二');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(mockApi.sendMessage).toHaveBeenCalledWith('c1', '联调排期改到下周二'));
    // 限流不是「发出去了但没显示」，是根本没发出去 —— 内容必须原样还给用户。
    await waitFor(() => expect(input).toHaveValue('联调排期改到下周二'));
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  it('乐观插进列表的那条消息要撤掉，别让人以为已经发出去了', async () => {
    mockApi.sendMessage.mockRejectedValue(await rateLimited(60_000));
    const input = await mount();
    const user = userEvent.setup();

    await user.type(input, '这条其实没发出去');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(input).toHaveValue('这条其实没发出去'));
    // 输入框里那份是草稿，消息列表里不该同时还挂着一条「已发送」的同样内容。
    // 把 textarea 自己排掉：它的 value 也会被文本查询命中，那正是我们要保留的草稿。
    const echoes = screen.queryAllByText('这条其实没发出去').filter((el) => el.tagName !== 'TEXTAREA');
    expect(echoes).toHaveLength(0);
  });

  it('@AI 那一档被限时同样说得出时间，草稿一样留着', async () => {
    mockApi.sendMessage.mockRejectedValue(await rateLimited(3 * 60_000, '@Aria 太频繁了，请稍后再试'));
    const input = await mount();
    const user = userEvent.setup();

    await user.type(input, '帮我看下这个报错');
    await user.keyboard('{Enter}');

    const toast = await screen.findByRole('status');
    expect(toast.textContent).toMatch(/@Aria 太频繁了/);
    expect(toast.textContent).toMatch(/\d{2}:\d{2} 后可以再发/);
    await waitFor(() => expect(input).toHaveValue('帮我看下这个报错'));
  });

  it('限流解除后照常发得出去 —— 不需要刷新页面', async () => {
    mockApi.sendMessage.mockRejectedValueOnce(await rateLimited(60_000));
    const input = await mount();
    const user = userEvent.setup();

    await user.type(input, '窗口过了再发一次');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(input).toHaveValue('窗口过了再发一次'));

    // 窗口过去了，服务端放行：草稿原封不动地再发一次就该成功。
    mockApi.sendMessage.mockResolvedValue({ message: { ...EXISTING, id: 'm2', senderId: ME.id, body: '窗口过了再发一次' } });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(input).toHaveValue(''));
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(2);
  });
});
