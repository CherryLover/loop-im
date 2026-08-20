// 引用回复的整条链路：消息气泡上点「回复」→ 输入框上方出现引用态 →
// 发出去时把被引用消息的 id 一起带上 → 在途气泡里就能看到引用块。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiPublicInfo, Conversation, Message, User } from './lib/types';

// useStream 会真的开 EventSource，jsdom 里没有。这个用例不需要推送，换成空实现即可。
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
const AI: AiPublicInfo = { name: 'Aria', providerLabel: '模拟供应商', silentRead: false, allowDm: true };

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

const ORIGINAL: Message = {
  id: 'm_1',
  conversationId: 'c1',
  senderId: PEER.id,
  senderName: PEER.name,
  senderAvatarUrl: null,
  body: '联调排期改到下周二',
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

/** 页面上还有一个「搜索会话」输入框，得指名道姓地拿输入消息的那个。 */
const composerInput = () => screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;

async function mount() {
  const { AppShell } = await import('./AppShell');
  render(
    <AppShell me={ME} ai={AI} theme="light" onToggleTheme={vi.fn()} onSignOut={vi.fn()} justSignedIn={false} />,
  );
  await waitFor(() => expect(screen.getByText('联调排期改到下周二')).toBeInTheDocument());
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset().mockResolvedValue({});
  mockApi.conversations.mockResolvedValue({ conversations: [conversation] });
  mockApi.users.mockResolvedValue({ users: [ME, PEER] });
  mockApi.me.mockResolvedValue({ user: ME, ai: AI });
  mockApi.ping.mockResolvedValue({ online: true, users: [ME, PEER] });
  mockApi.aiContext.mockResolvedValue({ line: '' });
  mockApi.markRead.mockResolvedValue({ conversationId: 'c1', lastReadAt: 1, unread: 0 });
  mockApi.messages.mockResolvedValue({ messages: [ORIGINAL], hasMore: false, nextBefore: null, reads: [] });
  vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(false);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('引用回复的整条链路', () => {
  it('点气泡上的「回复」，输入框上方就出现引用态', async () => {
    await mount();
    await userEvent.click(screen.getByRole('button', { name: '引用回复 陈子航 的消息' }));

    expect(screen.getByText('回复 陈子航')).toBeInTheDocument();
  });

  it('发送时把被引用消息的 id 一起带给服务端', async () => {
    mockApi.sendMessage.mockResolvedValue({
      message: {
        ...ORIGINAL, id: 'm_2', senderId: ME.id, senderName: ME.name, body: '收到',
        replyTo: 'm_1', quote: { senderName: '陈子航', preview: '联调排期改到下周二', available: true },
      },
    });
    await mount();

    await userEvent.click(screen.getByRole('button', { name: '引用回复 陈子航 的消息' }));
    await userEvent.type(composerInput(), '收到');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(mockApi.sendMessage).toHaveBeenCalledWith('c1', '收到', 'm_1'));
    // 服务端确认之后，气泡里挂着的是服务端给的权威摘要
    await waitFor(() => expect(screen.getByRole('button', { name: /联调排期改到下周二/ })).toBeInTheDocument());
  });

  it('在途气泡就带上引用块，不用等服务端确认', async () => {
    let resolve: (v: { message: Message }) => void = () => {};
    mockApi.sendMessage.mockImplementation(() => new Promise((r) => { resolve = r as typeof resolve; }));
    await mount();

    await userEvent.click(screen.getByRole('button', { name: '引用回复 陈子航 的消息' }));
    await userEvent.type(composerInput(), '收到');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    // 还没 resolve，气泡已经在了，而且带着引用摘要
    await waitFor(() => expect(screen.getByText('发送中…')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /联调排期改到下周二/ })).toBeInTheDocument();

    resolve({
      message: {
        ...ORIGINAL, id: 'm_2', senderId: ME.id, senderName: ME.name, body: '收到',
        replyTo: 'm_1', quote: { senderName: '陈子航', preview: '联调排期改到下周二', available: true },
      },
    });
    await waitFor(() => expect(screen.queryByText('发送中…')).not.toBeInTheDocument());
  });

  it('不引用时请求体不带 replyTo，调用形态和以前一样', async () => {
    mockApi.sendMessage.mockResolvedValue({
      message: { ...ORIGINAL, id: 'm_3', senderId: ME.id, senderName: ME.name, body: '随便说一句' },
    });
    await mount();

    await userEvent.type(composerInput(), '随便说一句');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(mockApi.sendMessage).toHaveBeenCalledWith('c1', '随便说一句'));
  });

  it('发送失败时引用态还回输入框，不用重新选一遍', async () => {
    mockApi.sendMessage.mockRejectedValue(new Error('服务暂时不可用'));
    await mount();

    await userEvent.click(screen.getByRole('button', { name: '引用回复 陈子航 的消息' }));
    await userEvent.type(composerInput(), '收到');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(composerInput()).toHaveValue('收到'));
    expect(screen.getByText('回复 陈子航')).toBeInTheDocument();
  });
});
