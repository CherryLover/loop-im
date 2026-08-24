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

// 「这台设备有没有推送订阅」决定切到后台之后本地还弹不弹（有订阅就交给推送）。
// jsdom 里 ensurePushSubscription 永远订不上，所以这个值只能由用例自己拨。
let subscribed = false;
vi.mock('./lib/push', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/push')>();
  return { ...actual, pushSubscribed: () => subscribed, ensurePushSubscription: async () => subscribed };
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
  'changePassword', 'upload', 'uploadAvatar', 'searchMessages', 'pushVisibility',
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

/**
 * 只能动态 import：这个文件里的 `vi.mock('./lib/api')` 工厂引用了下面才声明的 mockApi，
 * 而 visibility.ts 会 import api —— 顶层静态 import 它会把那个工厂提前跑起来，
 * 撞上「Cannot access 'mockApi' before initialization」。
 */
const resetVisibility = async () => (await import('./lib/visibility')).resetVisibilityForTest();

beforeEach(async () => {
  handlers = {};
  shown = [];
  subscribed = false;
  await resetVisibility();
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
  void resetVisibility();
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
    const hint = await screen.findByText(/当前浏览器不支持桌面通知/);
    // 这句话对**桌面**老浏览器成立，对 iOS 只在「装到主屏之后仍然没有」时才成立，
    // 所以补一句版本门槛，否则 iOS 16.4 以下的用户装完主屏还是不知道自己卡在哪。
    expect(hint).toHaveTextContent('iOS 16.4');
    expect(screen.getByRole('button', { name: /已关闭/ })).toBeDisabled();
    // jsdom 的 UA 里没有 iPhone / iPad，绝不能报成「去添加到主屏幕」
    expect(screen.queryByText(/添加到主屏幕/)).not.toBeInTheDocument();
  });
});

// iOS Safari 标签页里 Notification 就是 undefined，老代码把它判成「当前浏览器不支持
// 桌面通知」——而这句话是错的：iOS 上所有浏览器都是同一个 WebKit，用户照着提示换个
// 浏览器只会更困惑。唯一的出路是「添加到主屏幕」。
describe('iOS 标签页：说「加到主屏幕」，不说「浏览器不支持」', () => {
  const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

  /**
   * iOS Safari 标签页：iOS 的 UA、没有 Notification、不是独立模式、HTTPS。
   *
   * `matchMedia: false` 表示连 matchMedia 都不装（jsdom 的原样）。真机 iOS 当然有
   * 这个 API，但只有让它缺席，才能顺带压住「探测函数在最恶劣的环境下也不能把
   * SSE 回调带崩」这条——判定结果两种情况下都是 needs-install，走的路不一样。
   */
  const stubIosTab = (opts: { matchMedia?: boolean } = {}) => {
    vi.stubGlobal('navigator', { userAgent: IOS_UA, standalone: false });
    if (opts.matchMedia !== false) {
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }));
    }
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('Notification', undefined);
  };

  it('开关置灰，提示里给出「分享 → 添加到主屏幕」这条具体可执行的路', async () => {
    stubIosTab();
    await mount();

    await openProfile();
    const hint = await screen.findByText(/添加到主屏幕/);
    expect(hint).toHaveTextContent('分享');
    expect(hint).toHaveTextContent('从主屏图标打开');
    // 主屏 App 是独立的存储沙箱，进去要重新登录一次——不写清楚，用户会以为装坏了
    expect(hint).toHaveTextContent('重新登录');
    expect(hint).toHaveTextContent('保持登录');
    expect(screen.getByRole('button', { name: /已关闭/ })).toBeDisabled();
  });

  it('不再出现「当前浏览器不支持桌面通知」这句误导的话', async () => {
    stubIosTab();
    await mount();

    await openProfile();
    await screen.findByText(/添加到主屏幕/);
    expect(screen.queryByText(/当前浏览器不支持桌面通知/)).not.toBeInTheDocument();
  });

  it('按钮置灰，硬点也不会假装打开', async () => {
    stubIosTab();
    await mount();

    await openProfile();
    const toggle = await screen.findByRole('button', { name: /已关闭/ });
    expect(toggle).toBeDisabled();
    await userEvent.click(toggle, { pointerEventsCheck: 0 });
    // 开关不能翻成「已开启」——这一档 Notification 根本不存在，翻上去就是骗人
    expect(await screen.findByRole('button', { name: /已关闭/ })).toBeInTheDocument();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('装到主屏之后（有 Notification）就走回原来的三档，提示里不再提安装', async () => {
    vi.stubGlobal('navigator', { userAgent: IOS_UA, standalone: true });
    vi.stubGlobal('isSecureContext', true);
    stubNotification('default');
    await mount();

    await openProfile();
    expect(await screen.findByText(/打开后会向浏览器申请一次通知权限/)).toBeInTheDocument();
    expect(screen.queryByText(/添加到主屏幕/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /已关闭/ })).not.toBeDisabled();
  });

  it('非 HTTPS 的 iOS 标签页说的是 HTTPS，不是安装——装了也一样没有', async () => {
    stubIosTab();
    vi.stubGlobal('isSecureContext', false);
    await mount();

    await openProfile();
    expect(await screen.findByText(/当前不是 HTTPS/)).toBeInTheDocument();
    expect(screen.queryByText(/添加到主屏幕/)).not.toBeInTheDocument();
  });

  it('收到消息照样不抛异常，消息本身进列表（连 matchMedia 都没有时也一样）', async () => {
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
    prefOn();
    stubIosTab({ matchMedia: false });
    expect(window.matchMedia).toBeUndefined();
    await mount();

    await incoming();

    expect(shown).toHaveLength(0);
    expect(await screen.findByText('内容 m2')).toBeInTheDocument();
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

// 「点了开启，但好像没有消息发出来」这条反馈，三件事叠在一起：
// 1) 设计上只在用户看不见消息时才弹（上面那一组已经锁死，不改判据）；
// 2) 开启时没有任何反馈——真缺陷，补一条确认通知 + 把「什么时候才会弹」写在界面上；
// 3) 非 HTTPS 访问时浏览器直接禁用 Notification，以前只会含糊地说「浏览器不支持」。
describe('开启时要给反馈，别让人以为坏了', () => {
  it('开成功的当下立刻弹一条确认通知，用户马上知道通道是通的', async () => {
    stubNotification('default');
    requestPermission = vi.fn(async () => {
      FakeNotification.permission = 'granted';
      return 'granted' as NotificationPermission;
    });
    await mount();

    await openProfile();
    await userEvent.click(await screen.findByRole('button', { name: /已关闭/ }));

    await waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0].title).toBe('桌面通知已开启');
    expect(shown[0].options.body).toContain('切到别的标签页');
  });

  it('权限没拿到就不会弹这条确认（否则等于骗人）', async () => {
    stubNotification('default');
    requestPermission = vi.fn(async () => {
      FakeNotification.permission = 'denied';
      return 'denied' as NotificationPermission;
    });
    await mount();

    await openProfile();
    await userEvent.click(await screen.findByRole('button', { name: /已关闭/ }));

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    expect(shown).toHaveLength(0);
  });

  it('关掉开关不会弹通知', async () => {
    stubNotification();
    prefOn();
    await mount();

    await openProfile();
    await userEvent.click(await screen.findByRole('button', { name: /已开启/ }));

    await screen.findByRole('button', { name: /已关闭/ });
    expect(shown).toHaveLength(0);
  });

  it('界面上写明了什么时候才会弹——开着却停在聊天页是不弹的，不写没人猜得到', async () => {
    stubNotification();
    prefOn();
    await mount();

    await openProfile();
    const hint = await screen.findByText(/只在你看不见这条消息时才弹/);
    expect(hint).toHaveTextContent('切到别的标签页');
    expect(hint).toHaveTextContent('别的应用');
    expect(hint).toHaveTextContent('联系人');
    expect(hint).toHaveTextContent('正开着这个会话就不弹');
  });

  it('还没开的时候就说清楚：会申请一次权限，之后只在看不见时弹', async () => {
    stubNotification('default');
    await mount();

    await openProfile();
    const hint = await screen.findByText(/打开后会向浏览器申请一次通知权限/);
    expect(hint).toHaveTextContent('立刻弹一条确认通知');
    expect(hint).toHaveTextContent('切到别的标签页');
  });

  it('置灰的按钮把原因挂在自己身上（aria-describedby），不是只留一个点不动的灰按钮', async () => {
    stubNotification('denied');
    await mount();

    await openProfile();
    const toggle = await screen.findByRole('button', { name: /已关闭/ });
    expect(toggle).toBeDisabled();
    const hint = document.getElementById(toggle.getAttribute('aria-describedby') || '');
    expect(hint).toHaveTextContent('浏览器已拒绝本站的通知权限');
    expect(toggle).toHaveAttribute('title', expect.stringContaining('浏览器已拒绝本站的通知权限'));
  });
});

describe('非 HTTPS 访问（非安全上下文）', () => {
  // Notification 是 [SecureContext] 接口：走 http://内网IP 时浏览器干脆不给，
  // 权限申请连弹都不弹。以前这一档会被报成「当前浏览器不支持」——把 URL 的问题
  // 赖给浏览器，用户换个浏览器还是不行。
  it('明确告诉用户是 HTTPS 的问题，而不是浏览器的问题', async () => {
    vi.stubGlobal('isSecureContext', false);
    stubNotification('default');
    await mount();

    await openProfile();
    const hint = await screen.findByText(/当前不是 HTTPS/);
    expect(hint).toHaveTextContent('浏览器禁用了桌面通知');
    expect(hint).toHaveTextContent('https://');
    expect(screen.queryByText(/当前浏览器不支持桌面通知/)).not.toBeInTheDocument();
  });

  it('开关置灰，点不出一次注定失败的权限申请', async () => {
    vi.stubGlobal('isSecureContext', false);
    stubNotification('default');
    await mount();

    await openProfile();
    const toggle = await screen.findByRole('button', { name: /已关闭/ });
    expect(toggle).toBeDisabled();
    await userEvent.click(toggle, { pointerEventsCheck: 0 });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('即便偏好开着也不会弹消息通知——环境不允许，静默失灵才是最坏的', async () => {
    vi.stubGlobal('isSecureContext', false);
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
    stubNotification();                       // 假装 Notification 还在且已授权
    prefOn();
    await mount();

    await incoming();

    expect(shown).toHaveLength(0);
    expect(await screen.findByText('内容 m2')).toBeInTheDocument();
  });

  it('jsdom / 老浏览器上 isSecureContext 是 undefined，属于「不知道」，不能据此判死', async () => {
    // 这条是防呆：如果把判断写成 !window.isSecureContext，上面所有用例会一起变绿而功能全废。
    expect(window.isSecureContext).toBeUndefined();
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
    stubNotification();
    prefOn();
    await mount();

    await incoming();
    expect(shown).toHaveLength(1);
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

/**
 * ── 切后台之后谁来通知：本地弹，还是交给推送 ────────────────────────────────
 *
 * 这一组是「切后台后立刻发的消息收不到推送」那个真机 bug 的前端一侧。两件事：
 *
 * 1. **上报**：页面切前台 / 切后台都要告诉服务端一声。服务端不再拿 SSE 连接在不在去猜
 *    ——iOS 冻结 PWA 时 TCP 不会立刻断，猜出来是错的。
 * 2. **交接**：有推送订阅的设备切到后台后，本地就不弹了（同一条消息两条通知，
 *    tag 相同会互相覆盖，但手机会震两下）；**没有订阅的设备必须一切照旧**。
 *
 * 第 2 条的后半句是硬要求：没配 VAPID / 没授权 / 浏览器不支持推送的设备只有本地这一条路，
 * 弄丢了就是「切到后台什么都收不到」。
 */
describe('页面可见性上报', () => {
  const visibilityCalls = () => mockApi.pushVisibility.mock.calls.map((c) => c[0]);

  it('页面一起来就报一次「我在前台」—— 不报的话服务端默认按后台算，开着页面也照收推送', async () => {
    await mount();
    await waitFor(() => expect(mockApi.pushVisibility).toHaveBeenCalled());
    expect(visibilityCalls()[0]).toMatchObject({ visible: true });
    expect(visibilityCalls()[0].deviceId).toBeTruthy();
    expect(visibilityCalls()[0].streamId).toBeTruthy();
  });

  it('⚠️ 切到后台时报一次「我切后台了」—— 这一发就是本次修复的核心', async () => {
    await mount();
    await waitFor(() => expect(mockApi.pushVisibility).toHaveBeenCalled());

    vi.spyOn(Object.getPrototypeOf(document), 'visibilityState' as never, 'get').mockReturnValue('hidden' as never);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

    await waitFor(() => expect(visibilityCalls().at(-1)).toMatchObject({ visible: false }));
  });

  it('切回前台再报一次 —— 少了它，回到前台还在收推送', async () => {
    const state = vi.spyOn(Object.getPrototypeOf(document), 'visibilityState' as never, 'get');
    state.mockReturnValue('visible' as never);
    await mount();
    await waitFor(() => expect(mockApi.pushVisibility).toHaveBeenCalled());

    state.mockReturnValue('hidden' as never);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    state.mockReturnValue('visible' as never);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

    expect(visibilityCalls().at(-1)).toMatchObject({ visible: true });
  });

  it('SSE（重）连上时重报一遍：服务端把这个状态挂在连接上，换条连接就是一张白纸', async () => {
    await mount();
    await waitFor(() => expect(mockApi.pushVisibility).toHaveBeenCalled());
    const before = mockApi.pushVisibility.mock.calls.length;

    await act(async () => { handlers.onOpen?.(); });

    expect(mockApi.pushVisibility.mock.calls.length).toBe(before + 1);
    expect(visibilityCalls().at(-1)).toMatchObject({ visible: true });
  });

  it('上报接口报错不打断页面：消息照样进列表', async () => {
    mockApi.pushVisibility.mockRejectedValue(new Error('网络抖了'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mount();
    await incoming();
    expect(await screen.findByText('内容 m2')).toBeInTheDocument();
  });
});

describe('有推送订阅时把后台通知交给推送', () => {
  const mountHidden = async () => {
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
    vi.spyOn(Object.getPrototypeOf(document), 'visibilityState' as never, 'get').mockReturnValue('hidden' as never);
    stubNotification();
    prefOn();
    return mount();
  };

  it('有订阅 + 页面切走 → 本地不弹，交给推送（否则同一条消息震两下）', async () => {
    subscribed = true;
    await mountHidden();
    await incoming();
    expect(shown).toHaveLength(0);
  });

  it('⚠️ 没有订阅 + 页面切走 → 照旧弹（硬要求：不能回归成「切后台什么都收不到」）', async () => {
    // 没配 VAPID、用户没授权、浏览器不支持推送的设备全落在这一档，本地是唯一的通道。
    subscribed = false;
    await mountHidden();
    await incoming();
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('陈子航 · 发版协作');
  });

  it('⚠️ 有订阅但页面**开着**（人只是切到了联系人页）→ 照旧弹', async () => {
    // 页面开着时这台设备报告的是「前台」，服务端**不会**推。这时候本地再不弹，
    // 用户就什么都收不到了。判据是 document.hidden，不是「这条消息在不在眼前」。
    subscribed = true;
    stubNotification();
    prefOn();
    await mount();
    await waitFor(() => expect(mockApi.markRead).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getAllByRole('button', { name: '联系人' })[0]);
    await screen.findByPlaceholderText('搜索姓名或邮箱');

    await incoming();
    expect(shown).toHaveLength(1);
  });
});
