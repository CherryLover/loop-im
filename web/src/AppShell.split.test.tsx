// 文字和媒体各占一个气泡，从输入框一路走到消息列表这一层：
// 一次发送产生**两条**消息、**两个**乐观气泡，各自独立地确认或失败。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiPublicInfo, Conversation, Message, User } from './lib/types';

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

/** 服务端确认回来的那条消息。 */
const confirmed = (id: string, body: string): { message: Message } => ({
  message: { ...ORIGINAL, id, senderId: ME.id, senderName: ME.name, body },
});

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

/** 选一张图并等它上传完。 */
async function attachImage() {
  const input = document.querySelector('.composer input[type="file"]') as HTMLInputElement;
  await userEvent.upload(input, new File(['fake'], 'shot.png', { type: 'image/png' }));
  await screen.findByText('已上传，将作为图片附件发送');
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
  mockApi.upload.mockResolvedValue({
    url: '/uploads/9f3a.png', filename: 'shot.png', kind: 'image', storage: 'local',
  });
  vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(false);
  Element.prototype.scrollIntoView = vi.fn();
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
// 这个文件里的 mock 生命周期有个坑：必须先 cleanup() 再 restoreAllMocks()，
// 否则卸载时组件还会用到已经被还原掉的桩。
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('一次发送产生两条消息', () => {
  it('文字和图片各发一条，文字在前', async () => {
    mockApi.sendMessage
      .mockResolvedValueOnce(confirmed('m_2', '这是今天的构建结果'))
      .mockResolvedValueOnce(confirmed('m_3', '![shot.png](/uploads/9f3a.png)'));
    await mount();
    await attachImage();
    await userEvent.type(composerInput(), '这是今天的构建结果');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(mockApi.sendMessage).toHaveBeenCalledTimes(2));
    expect(mockApi.sendMessage.mock.calls[0]).toEqual(['c1', '这是今天的构建结果']);
    expect(mockApi.sendMessage.mock.calls[1]).toEqual(['c1', '![shot.png](/uploads/9f3a.png)']);
  });

  it('两条都落到消息列表上：一条文字气泡，一条图片气泡', async () => {
    mockApi.sendMessage
      .mockResolvedValueOnce(confirmed('m_2', '这是今天的构建结果'))
      .mockResolvedValueOnce(confirmed('m_3', '![shot.png](/uploads/9f3a.png)'));
    await mount();
    await attachImage();
    await userEvent.type(composerInput(), '这是今天的构建结果');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(screen.getByText('这是今天的构建结果')).toBeInTheDocument());
    await waitFor(() => {
      expect(document.querySelector('.bubble img[src="/uploads/9f3a.png"]')).not.toBeNull();
    });
    // 图片没有和文字挤在同一个气泡里。
    const textBubble = screen.getByText('这是今天的构建结果').closest('.bubble');
    expect(textBubble?.querySelector('img')).toBeNull();
  });

  it('乐观气泡也是两个：第一条确认之后，第二条自己在途', async () => {
    let resolveSecond: (v: { message: Message }) => void = () => {};
    mockApi.sendMessage
      .mockResolvedValueOnce(confirmed('m_2', '这是今天的构建结果'))
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r as typeof resolveSecond; }));
    await mount();
    await attachImage();
    await userEvent.type(composerInput(), '这是今天的构建结果');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    // 文字那条已经确认（不再是「发送中…」），图片那条还挂着在途标记。
    await waitFor(() => expect(screen.getByText('发送中…')).toBeInTheDocument());
    expect(screen.getAllByText('发送中…')).toHaveLength(1);
    const textBubble = screen.getByText('这是今天的构建结果').closest('.bubble');
    expect(textBubble?.textContent).not.toContain('发送中…');

    resolveSecond(confirmed('m_3', '![shot.png](/uploads/9f3a.png)'));
    await waitFor(() => expect(screen.queryByText('发送中…')).not.toBeInTheDocument());
  });

  it('图片那条失败时，文字那条留在对话里，只有附件回到输入框', async () => {
    mockApi.sendMessage
      .mockResolvedValueOnce(confirmed('m_2', '这是今天的构建结果'))
      .mockRejectedValueOnce(new Error('服务暂时不可用'));
    await mount();
    await attachImage();
    await userEvent.type(composerInput(), '这是今天的构建结果');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(mockApi.sendMessage).toHaveBeenCalledTimes(2));
    // 文字那条是真发出去了，它得留在列表里，而且不能退回输入框。
    await waitFor(() => expect(screen.getByText('这是今天的构建结果')).toBeInTheDocument());
    expect(composerInput()).toHaveValue('');
    // 失败的图片回到附件条上，等着重发；列表里没有留下它的在途气泡。
    expect(screen.getByText('已上传，将作为图片附件发送')).toBeInTheDocument();
    expect(screen.queryByText('发送中…')).not.toBeInTheDocument();
    expect(document.querySelector('.bubble img[src="/uploads/9f3a.png"]')).toBeNull();
  });
});
