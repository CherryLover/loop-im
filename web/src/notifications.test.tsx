// 浏览器桌面通知：切到别的标签页 / 别的页面时，新消息弹系统通知，点通知回到会话。
//
// 这里锁住的重点：
// - 可见性判据和已读上报是同一个（issue #20 的 chatDetailVisible）——同一条消息
//   要么被标成已读，要么弹通知，不可能两件事同时发生；
// - 免打扰（muted）的会话不弹。muted 由另一路改动接到服务端，前端这一侧先立住；
// - 不主动申请权限：只有用户在个人资料里自己打开开关才申请，被拒之后不再重复申请；
// - jsdom 没有 Notification，「浏览器不支持」这条降级路径不能抛异常把页面搞挂。
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
  role: 'admin', avatarUrl: null, isAI: false, online: true,
};
const PEER: User = { ...ME, id: 'u_chen', name: '陈子航', email: 'c@loop.dev', dept: '后端', role: 'member' };
const AI: AiPublicInfo = { name: 'Aria', providerLabel: '模拟供应商', silentRead: false, allowDm: true };

const T0 = 1_700_000_000_000;

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
  createdAt: T0,
  isAI: false,
  ...over,
});

const API_METHODS = [
  'conversations', 'users', 'me', 'ping', 'messages', 'markRead', 'sendMessage',
  'addMembers', 'removeMember', 'renameConversation', 'leaveConversation',
  'openDirect', 'createGroup', 'addUser', 'aiContext', 'updateName',
  'changePassword', 'upload', 'uploadAvatar', 'searchMessages',
] as const;

const mockApi = Object.fromEntries(API_METHODS.map((k) => [k, vi.fn()])) as
  Record<(typeof API_METHODS)[number], ReturnType<typeof vi.fn>>;

/** 弹出来的通知，按顺序记下来。 */
let shown: FakeNotification[];
let requestPermission: ReturnType<typeof vi.fn>;

/** jsdom 没有 Notification，自己造一个够用的替身。 */
class FakeNotification {
  static permission: 'default' | 'granted' | 'denied' = 'granted';
  static requestPermission = (...args: unknown[]) => requestPermission(...args);
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(public title: string, public options: NotificationOptions = {}) {
    shown.push(this);
  }
}

/** 装上 Notification 替身；permission 决定浏览器当前的授权状态。 */
function stubNotification(permission: 'default' | 'granted' | 'denied' = 'granted') {
  FakeNotification.permission = permission;
  vi.stubGlobal('Notification', FakeNotification);
}

/** 用户此前已经在设置里打开过桌面通知（偏好持久化在 localStorage）。 */
const prefOn = () => window.localStorage.setItem('loop-im-notify', 'on');

const pageOf = (messages: Message[], hasMore = false, nextBefore: string | null = null) =>
  ({ messages, hasMore, nextBefore, reads: [] as { userId: string; lastReadAt: number }[] });

async function mount(over: { conversations?: Conversation[] } = {}) {
  const list = over.conversations ?? [conversation()];
  mockApi.conversations.mockResolvedValue({ conversations: list });

  const { AppShell } = await import('./AppShell');
  render(
    <AppShell me={ME} ai={AI} theme="light" onToggleTheme={vi.fn()} onSignOut={vi.fn()} justSignedIn={false} />,
  );
  await waitFor(() => expect(mockApi.conversations).toHaveBeenCalled());
  // 等首屏消息真的落进列表再往下走：否则「加载首页」的 setMessages 会在
  // handlers.onMessage 之后才结算，把测试推进去的新消息又冲掉。
  if (list.length) await screen.findByText('内容 m1');
  return list;
}

/** 打开个人资料弹窗。这颗按钮的可访问名是头像首字，只能按 title 找。 */
const openProfile = () => userEvent.click(screen.getByTitle('个人资料'));

/** 收到一条新消息（默认是别人在 c1 里发的）。 */
const incoming = async (over: Partial<Message> = {}) =>
  act(async () => { handlers.onMessage?.(message('m2', { createdAt: T0 + 1000, ...over })); });

beforeEach(() => {
  handlers = {};
  shown = [];
  requestPermission = vi.fn(async () => FakeNotification.permission);
  window.localStorage.clear();
  for (const fn of Object.values(mockApi)) fn.mockReset().mockResolvedValue({});
  mockApi.conversations.mockResolvedValue({ conversations: [] });
  mockApi.users.mockResolvedValue({ users: [ME, PEER] });
  mockApi.me.mockResolvedValue({ user: ME, ai: AI });
  mockApi.ping.mockResolvedValue({ online: true, users: [ME, PEER] });
  mockApi.aiContext.mockResolvedValue({ line: '' });
  mockApi.markRead.mockResolvedValue({ conversationId: 'c1', lastReadAt: 1, unread: 0 });
  mockApi.messages.mockResolvedValue(pageOf([message('m1')], false, null));
  mockApi.searchMessages.mockResolvedValue({ query: '', results: [], hasMore: false, nextBefore: null });
  vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(false);
});

afterEach(() => {
  // 必须先卸载再还原 mock：反过来的话，残留组件卸载期间跑的 effect 会打到
  // 已被清空的桩上，抛出与本用例无关的 "api.xxx is not a function"。
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('看不见这条消息时才弹通知', () => {
  it('标签页切走时弹通知，标题是「发送者 · 群名」，正文是清洗过的摘要', async () => {
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
    stubNotification();
    prefOn();
    await mount();

    await incoming({ body: '**周五**发版，见 ![图](/uploads/a.png)' });

    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('陈子航 · 发版协作');
    // 摘要走的是 messages.ts 里那份唯一的 previewOf：Markdown 记号去掉、图片折成 [图片]
    expect(shown[0].options.body).toBe('周五 发版，见 [图片]');
    // 标签页不可见 → 同一条消息也不会被标成已读，两件事共用一个判据
    expect(mockApi.markRead).not.toHaveBeenCalled();
  });

  it('人在联系人页时（会话还选着，但详情不在眼前）照样弹', async () => {
    stubNotification();
    prefOn();
    await mount();
    await waitFor(() => expect(mockApi.markRead).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getAllByRole('button', { name: '联系人' })[0]);
    await screen.findByPlaceholderText('搜索姓名或邮箱');

    await incoming();
    expect(shown).toHaveLength(1);
  });

  it('人正看着这个会话时不弹——只标已读，不打扰', async () => {
    stubNotification();
    prefOn();
    await mount();
    await waitFor(() => expect(mockApi.markRead).toHaveBeenCalledTimes(1));

    await incoming();

    expect(shown).toHaveLength(0);
    await waitFor(() => expect(mockApi.markRead).toHaveBeenCalledTimes(2));
  });

  it('详情开着的是另一个会话时，别的会话来消息仍然弹', async () => {
    stubNotification();
    prefOn();
    await mount({ conversations: [conversation(), conversation({ id: 'c2', title: '设计评审' })] });
    await waitFor(() => expect(mockApi.markRead).toHaveBeenCalledWith('c1', expect.anything()));

    await incoming({ conversationId: 'c2' });
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('陈子航 · 设计评审');
  });

  it('单聊不带会话标题，标题就是发送者本人', async () => {
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
    stubNotification();
    prefOn();
    await mount({ conversations: [conversation({ type: 'dm', title: '陈子航', peerId: PEER.id })] });

    await incoming();
    expect(shown[0].title).toBe('陈子航');
  });
});

describe('不该打扰的情况', () => {
  const mountHidden = async (over: { conversations?: Conversation[] } = {}) => {
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
    stubNotification();
    prefOn();
    return mount(over);
  };

  it('免打扰的会话不弹通知（muted）', async () => {
    await mountHidden({ conversations: [conversation({ muted: true })] });

    await incoming();

    expect(shown).toHaveLength(0);
  });

  it('同一批里免打扰的那个不弹，没设免打扰的照弹', async () => {
    await mountHidden({ conversations: [
      conversation({ muted: true }),
      conversation({ id: 'c2', title: '设计评审' }),
    ] });

    await incoming({ conversationId: 'c1' });
    expect(shown).toHaveLength(0);

    await incoming({ conversationId: 'c2' });
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('陈子航 · 设计评审');
  });

  it('自己发的消息不弹（多端同步会把自己发的也推回来）', async () => {
    await mountHidden();
    await incoming({ senderId: ME.id, senderName: ME.name });
    expect(shown).toHaveLength(0);
  });

  it('系统消息不弹', async () => {
    await mountHidden();
    await incoming({ kind: 'system', body: '林悦 把 陈子航 移出了群聊' });
    expect(shown).toHaveLength(0);
  });

  it('没在设置里打开时不弹', async () => {
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
    stubNotification();                          // 权限有，但用户没打开开关
    await mount();
    await incoming();
    expect(shown).toHaveLength(0);
  });

  it('浏览器权限是 denied 时不弹，也不会去申请权限', async () => {
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
    stubNotification('denied');
    prefOn();
    await mount();
    await incoming();
    expect(shown).toHaveLength(0);
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe('浏览器不支持 Notification（降级）', () => {
  it('收到消息不抛异常，页面照常工作', async () => {
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
    prefOn();                                    // 偏好开着，但环境里根本没有 Notification
    vi.stubGlobal('Notification', undefined);
    await mount();

    await incoming();

    expect(shown).toHaveLength(0);
    // 消息本身照常进列表，SSE 回调没有被打断
    expect(await screen.findByText('内容 m2')).toBeInTheDocument();
  });

  it('设置里的开关置灰，并说明当前浏览器不支持', async () => {
    vi.stubGlobal('Notification', undefined);
    await mount();

    await openProfile();
    expect(await screen.findByText('当前浏览器不支持桌面通知。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /已关闭/ })).toBeDisabled();
  });
});

describe('权限申请是用户主动触发的', () => {
  it('页面加载、收到消息都不会申请权限', async () => {
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
    stubNotification('default');
    await mount();
    await incoming();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(shown).toHaveLength(0);
  });

  it('在设置里打开开关时才申请一次，拿到权限后开关记进 localStorage', async () => {
    stubNotification('default');
    requestPermission = vi.fn(async () => {
      FakeNotification.permission = 'granted';
      return 'granted' as NotificationPermission;
    });
    await mount();

    await openProfile();
    await userEvent.click(await screen.findByRole('button', { name: /已关闭/ }));

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: /已开启/ })).toBeInTheDocument();
    expect(window.localStorage.getItem('loop-im-notify')).toBe('on');
  });

  it('用户拒绝后开关不会假装打开，也不再重复申请', async () => {
    stubNotification('default');
    requestPermission = vi.fn(async () => {
      FakeNotification.permission = 'denied';
      return 'denied' as NotificationPermission;
    });
    await mount();

    await openProfile();
    await userEvent.click(await screen.findByRole('button', { name: /已关闭/ }));

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    // 开关仍是关的，并给出「去站点设置里手动允许」的说明；按钮置灰，点不出第二次申请
    expect(await screen.findByText(/浏览器已拒绝本站的通知权限/)).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /已关闭/ });
    expect(toggle).toBeDisabled();
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('偏好持久化：刷新（重新挂载）后开关还在，不用再申请一次', async () => {
    stubNotification();
    prefOn();
    await mount();

    await openProfile();
    expect(await screen.findByRole('button', { name: /已开启/ })).toBeInTheDocument();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('再点一次就关掉，并且写回 localStorage', async () => {
    stubNotification();
    prefOn();
    await mount();

    await openProfile();
    await userEvent.click(await screen.findByRole('button', { name: /已开启/ }));

    expect(await screen.findByRole('button', { name: /已关闭/ })).toBeInTheDocument();
    expect(window.localStorage.getItem('loop-im-notify')).toBe('off');
  });
});

describe('点通知回到对应会话', () => {
  it('聚焦窗口、切到会话页，并选中那条消息所在的会话', async () => {
    stubNotification();
    prefOn();
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    await mount({ conversations: [conversation(), conversation({ id: 'c2', title: '设计评审' })] });

    // 先切到联系人页，制造「看不见」的场景
    await userEvent.click(screen.getAllByRole('button', { name: '联系人' })[0]);
    await screen.findByPlaceholderText('搜索姓名或邮箱');

    await incoming({ conversationId: 'c2' });
    expect(shown).toHaveLength(1);

    await act(async () => { shown[0].onclick?.(); });

    expect(focus).toHaveBeenCalled();
    expect(shown[0].close).toHaveBeenCalled();
    // 回到会话页，并且打开的是 c2
    await waitFor(() => expect(mockApi.messages).toHaveBeenCalledWith('c2', expect.anything()));
    expect(await screen.findByPlaceholderText(/输入消息/)).toBeInTheDocument();
  });

  it('同一会话连着来消息时用同一个 tag，通知不会堆一屏', async () => {
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
    stubNotification();
    prefOn();
    await mount();

    await incoming({ id: 'm2' });
    await incoming({ id: 'm3' });

    expect(shown.map((n) => n.options.tag)).toEqual(['loop-im:c1', 'loop-im:c1']);
  });
});
