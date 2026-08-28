// AppShell 是把新功能粘起来的那一层：已读上报的节流与补报、历史翻页的游标推进、
// SSE 已读广播的合并、群管理弹窗的开合。这些逻辑各自都不平凡，之前完全没有测试。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
  role: 'admin', avatarUrl: null, isAI: false, online: true,
};
const PEER: User = { ...ME, id: 'u_chen', name: '陈子航', email: 'c@loop.dev', dept: '后端', role: 'member' };

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

const message = (id: string, over: Partial<Message> = {}): Message => ({
  id,
  conversationId: 'c1',
  senderId: PEER.id,
  senderName: PEER.name,
  senderAvatarUrl: null,
  body: `内容 ${id}`,
  mentions: [],
  createdAt: 1_700_000_000_000,
  isAI: false,
  ...over,
});

// AppShell 这棵子树会用到的全部接口，逐个打桩。列全是有意的：
// 少一个就会在渲染中途抛 "not a function"，而不是给出有意义的失败。
const API_METHODS = [
  'conversations', 'users', 'me', 'ping', 'messages', 'markRead', 'sendMessage',
  'addMembers', 'removeMember', 'renameConversation', 'leaveConversation',
  'openDirect', 'createGroup', 'addUser', 'aiContext', 'updateName',
  'changePassword', 'upload', 'uploadAvatar',
] as const;

const mockApi = Object.fromEntries(API_METHODS.map((k) => [k, vi.fn()])) as
  Record<(typeof API_METHODS)[number], ReturnType<typeof vi.fn>>;

async function mount(over: { conversations?: Conversation[] } = {}) {
  const list = over.conversations ?? [conversation()];
  mockApi.conversations.mockResolvedValue({ conversations: list });

  const { AppShell } = await import('./AppShell');
  render(
    <AppShell me={ME} theme="light" onToggleTheme={vi.fn()} onSignOut={vi.fn()} justSignedIn={false} />,
  );
  await waitFor(() => expect(mockApi.conversations).toHaveBeenCalled());
  return list;
}

const pageOf = (messages: Message[], hasMore = false, nextBefore: string | null = null) =>
  ({ messages, hasMore, nextBefore, reads: [] as { userId: string; lastReadAt: number }[] });

beforeEach(() => {
  handlers = {};
  // 全部桩先给一个安全默认值：任何一个返回 undefined 都会让组件里的 .then 炸掉，
  // 报出来的还是无关的 TypeError，掩盖真正的断言。
  for (const fn of Object.values(mockApi)) fn.mockReset().mockResolvedValue({});
  mockApi.conversations.mockResolvedValue({ conversations: [] });
  mockApi.users.mockResolvedValue({ users: [ME, PEER] });
  mockApi.me.mockResolvedValue({ user: ME });
  mockApi.ping.mockResolvedValue({ online: true, users: [ME, PEER] });
  mockApi.aiContext.mockResolvedValue({ line: '' });
  mockApi.markRead.mockResolvedValue({ conversationId: 'c1', lastReadAt: 1, unread: 0 });
  mockApi.messages.mockResolvedValue(pageOf([message('m1')], false, null));
  vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(false);
});
afterEach(() => {
  // 必须先卸载再还原 mock：反过来的话，残留组件在卸载期间跑的 effect
  // 会拿到已被清空的桩，抛出与本用例无关的错误。
  cleanup();
  vi.restoreAllMocks();
});

describe('已读上报', () => {
  it('打开会话就上报一次已读', async () => {
    await mount();
    // 上报位置是此刻渲染出来的最后一条消息，而不是「服务端的此刻」（issue #20）。
    await waitFor(() => expect(mockApi.markRead).toHaveBeenCalledWith('c1', 1_700_000_000_000));
    expect(mockApi.markRead).toHaveBeenCalledTimes(1);
  });

  it('1 秒内不重复上报（节流）', async () => {
    await mount();
    await waitFor(() => expect(mockApi.markRead).toHaveBeenCalledTimes(1));

    // 连着来三条新消息，节流窗口内只应有最初那一次上报
    await act(async () => {
      for (const id of ['m2', 'm3', 'm4']) handlers.onMessage?.(message(id));
    });
    expect(mockApi.markRead).toHaveBeenCalledTimes(1);
  });

  it('自己发的消息不会触发已读上报', async () => {
    await mount();
    await waitFor(() => expect(mockApi.markRead).toHaveBeenCalledTimes(1));
    mockApi.markRead.mockClear();

    await act(async () => { handlers.onMessage?.(message('m9', { senderId: ME.id })); });
    expect(mockApi.markRead).not.toHaveBeenCalled();
  });

  it('页面不可见时不上报 —— 人没在看就不算读过', async () => {
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
    await mount();
    await waitFor(() => expect(mockApi.conversations).toHaveBeenCalled());
    expect(mockApi.markRead).not.toHaveBeenCalled();
  });

  it('上报失败后允许重试，不会因为节流标记被永久卡住', async () => {
    mockApi.markRead.mockRejectedValueOnce(new Error('网络错误'));
    await mount();
    await waitFor(() => expect(mockApi.markRead).toHaveBeenCalledTimes(1));

    // 失败会把节流标记清零，切回窗口时应当能再报一次
    mockApi.markRead.mockResolvedValue({ conversationId: 'c1', lastReadAt: 2, unread: 0 });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(mockApi.markRead).toHaveBeenCalledTimes(2));
  });
});

describe('未读徽标', () => {
  it('把各会话的未读加总显示在「会话」入口上', async () => {
    await mount({ conversations: [
      conversation({ id: 'c1', unread: 3 }),
      conversation({ id: 'c2', title: '另一个群', unread: 4 }),
    ] });
    await waitFor(() => expect(screen.getAllByLabelText('7 条未读').length).toBeGreaterThan(0));
  });

  it('总未读为 0 时不显示徽标', async () => {
    await mount({ conversations: [conversation({ unread: 0 })] });
    await waitFor(() => expect(mockApi.conversations).toHaveBeenCalled());
    expect(screen.queryByLabelText(/条未读/)).not.toBeInTheDocument();
  });
});

describe('历史翻页', () => {
  it('点「加载更早」会带上游标请求下一页，并把结果接在前面', async () => {
    mockApi.messages
      .mockResolvedValueOnce(pageOf([message('m5')], true, 'm5'))
      .mockResolvedValueOnce(pageOf([message('m1'), message('m2')], false, null));
    await mount();

    const button = await screen.findByRole('button', { name: '加载更早的消息' });
    await userEvent.click(button);

    await waitFor(() => expect(mockApi.messages).toHaveBeenCalledWith(
      'c1', expect.objectContaining({ before: 'm5' }),
    ));
    await waitFor(() => expect(screen.getByText('内容 m1')).toBeInTheDocument());
    expect(screen.getByText('内容 m5')).toBeInTheDocument();
    // 没有更早的了，入口应当消失
    await waitFor(() => expect(screen.queryByRole('button', { name: /加载更早/ })).not.toBeInTheDocument());
  });

  it('翻页失败时恢复可点击状态，不会卡在「加载中」', async () => {
    mockApi.messages
      .mockResolvedValueOnce(pageOf([message('m5')], true, 'm5'))
      .mockRejectedValueOnce(new Error('网络错误'));
    await mount();

    await userEvent.click(await screen.findByRole('button', { name: '加载更早的消息' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '加载更早的消息' })).toBeEnabled());
  });
});

describe('SSE 已读广播', () => {
  it('收到别人的已读位置后合并进状态，同一个人只保留最新值', async () => {
    mockApi.messages.mockResolvedValue(pageOf([message('m1', { senderId: ME.id, senderName: ME.name })], false, null));
    await mount();
    await screen.findByText('内容 m1');

    // 已读位置早于消息时间：仍是「已发送」
    await act(async () => { handlers.onRead?.('c1', PEER.id, 1_699_999_999_000); });
    expect(screen.getByText(/已发送/)).toBeInTheDocument();

    // 同一个人推进到消息之后：升级成「已读」，而不是又多算一个人
    await act(async () => { handlers.onRead?.('c1', PEER.id, 1_700_000_000_001); });
    await waitFor(() => expect(screen.getByText(/· 1 人已读/)).toBeInTheDocument());
  });
});

describe('发送消息', () => {
  it('成功时用服务端返回的消息替换掉在途的那条', async () => {
    mockApi.messages.mockResolvedValue(pageOf([], false, null));
    mockApi.sendMessage.mockResolvedValue({
      message: message('m_real', { senderId: ME.id, senderName: ME.name, body: '周五发版' }),
    });
    await mount();

    const input = await screen.findByPlaceholderText(/输入消息/);
    await userEvent.type(input, '周五发版');
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(mockApi.sendMessage).toHaveBeenCalledWith('c1', '周五发版'));
    await waitFor(() => expect(screen.getByText('周五发版')).toBeInTheDocument());
    expect(input).toHaveValue('');
  });

  // 这条是「发送失败恢复草稿」真正的集成点：AppShell 弹完提示必须把错误抛回去，
  // Composer 才有机会把用户打的字还原。少了任何一半这条都过不了。
  it('失败时提示原因、撤掉在途消息，并把草稿还回输入框', async () => {
    mockApi.messages.mockResolvedValue(pageOf([], false, null));
    mockApi.sendMessage.mockRejectedValue(new Error('服务暂时不可用'));
    await mount();

    const input = await screen.findByPlaceholderText(/输入消息/);
    await userEvent.type(input, '联调排期改到下周二');
    await userEvent.keyboard('{Enter}');

    expect(await screen.findByText('服务暂时不可用')).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveValue('联调排期改到下周二'));
    // 乐观插入的那条已经撤掉，不会留一条永远「发送中」的幽灵消息
    expect(screen.queryByText(/发送中/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });
});

describe('群管理', () => {
  it('点移除成员会调接口并刷新会话列表', async () => {
    mockApi.removeMember.mockResolvedValue({ conversation: conversation() });
    await mount();

    await userEvent.click(await screen.findByRole('button', { name: '将 陈子航 移出群聊' }));
    await waitFor(() => expect(mockApi.removeMember).toHaveBeenCalledWith('c1', PEER.id));
    expect(await screen.findByText(/已将 陈子航 移出群聊/)).toBeInTheDocument();
  });

  it('移除失败时给出提示而不是静默失败', async () => {
    mockApi.removeMember.mockRejectedValue(new Error('只有群主或管理员可以移除成员'));
    await mount();

    await userEvent.click(await screen.findByRole('button', { name: '将 陈子航 移出群聊' }));
    expect(await screen.findByText('只有群主或管理员可以移除成员')).toBeInTheDocument();
  });

  it('退群成功后关闭弹窗、给出回执，并切走选中的会话', async () => {
    mockApi.leaveConversation.mockResolvedValue({ ok: true });
    await mount();

    await userEvent.click(await screen.findByRole('button', { name: /退出群聊/ }));
    await userEvent.click(await screen.findByRole('button', { name: '确认退出' }));

    await waitFor(() => expect(mockApi.leaveConversation).toHaveBeenCalledWith('c1'));
    expect(await screen.findByText(/已退出「发版协作」/)).toBeInTheDocument();
    // 弹窗关闭，聊天区不再停在这个会话
    await waitFor(() => expect(screen.queryByRole('button', { name: '确认退出' })).not.toBeInTheDocument());
  });

  it('改群名走的是 PATCH 接口，并带上新名字', async () => {
    mockApi.renameConversation.mockResolvedValue({ conversation: conversation({ title: '新名字' }) });
    await mount();

    await userEvent.click(await screen.findByRole('button', { name: /修改群名/ }));
    const input = await screen.findByLabelText('群名称');
    await userEvent.clear(input);
    await userEvent.type(input, '新名字');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockApi.renameConversation).toHaveBeenCalledWith('c1', '新名字'));
  });
});
