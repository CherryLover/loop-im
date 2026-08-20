// issue #20：切离聊天详情之后，新消息仍然被自动标记为已读。
// 根子在于前端把「选中的会话」当成了「用户看得见的会话」——切到联系人页 / AI 管理页、
// 手机端从详情退回会话列表，会话都还选着，于是收到的消息被顺手标成已读，
// 发送方拿到了假的已读回执，接收方的未读数被清零。
// 这里锁住的是同一个判据：会话页 + 标签页可见 + 详情那一栏确实露着，才允许上报已读。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from './AppShell';
import type { StreamHandlers } from './lib/useStream';
import type { AiPublicInfo, Conversation, Message, User } from './lib/types';

// 实时通道换成把回调存下来，测试自己触发。
let handlers: StreamHandlers = {};
vi.mock('./lib/useStream', () => ({
  useStream: (_enabled: boolean, h: StreamHandlers) => { handlers = h; },
}));

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

interface Call { url: string; method: string; body: Record<string, unknown> | undefined }

let calls: Call[];
let convos: Conversation[];
let history: Message[];
// 已读上报自带 1 秒节流。真实场景里新消息不会都挤在打开会话的那一秒内到达，
// 用一个可推进的时钟把节流窗口越过去，否则用例是被节流挡住的，测不到真正的判据。
let clockOffset: number;

const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;
const readCalls = () => calls.filter((c) => c.url.endsWith('/read'));

/** 把视口切成手机布局：会话列表和聊天详情是前后两屏，返回列表后详情就不在眼前了。 */
const useMobileViewport = () => vi.stubGlobal(
  'matchMedia',
  (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }),
);

beforeEach(() => {
  handlers = {};
  calls = [];
  convos = [conversation()];
  history = [message('m1')];
  clockOffset = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(false);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method || 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url === '/api/conversations') return json({ conversations: convos });
    if (url === '/api/users') return json({ users: [ME, PEER] });
    if (url.endsWith('/messages')) return json({ messages: history, hasMore: false, nextBefore: null, reads: [] });
    if (url.endsWith('/read')) return json({ conversationId: 'c1', lastReadAt: T0, unread: 0 });
    if (url.endsWith('/ai-context')) return json({ line: '' });
    if (url.endsWith('/api/ai/overview')) return json({ configured: true, statusLine: '已接入', stats: [], rows: [] });
    return json({});
  }));
});

afterEach(() => {
  // 先卸载再还原：反过来的话，残留组件卸载期间跑的 effect 会打到已经被清空的桩上。
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountShell() {
  render(
    <AppShell me={ME} ai={AI} theme="light" onToggleTheme={vi.fn()} onSignOut={vi.fn()} justSignedIn={false} />,
  );
}

/** 隔一会儿（越过已读节流窗口）收到一条别人发来的新消息，会话列表随之带上未读。 */
async function incoming(id: string, createdAt: number, unread = 1) {
  clockOffset += 2000;
  convos = [conversation({ unread })];
  await act(async () => { handlers.onMessage?.(message(id, { createdAt })); });
}

const goto = async (name: RegExp | string) =>
  userEvent.click(screen.getAllByRole('button', { name })[0]);

/** 手机端从会话列表点进详情（列表里那一项，不是详情标题）。 */
async function openFromList() {
  const items = await screen.findAllByText('发版协作');
  await userEvent.click(items[0]);
}

describe('切离聊天详情后收到的新消息（issue #20）', () => {
  it('人在联系人页时不上报已读，未读徽标照常增加', async () => {
    mountShell();
    await waitFor(() => expect(readCalls()).toHaveLength(1));   // 打开会话时报过一次

    await goto('联系人');
    await screen.findByPlaceholderText('搜索姓名或邮箱');

    await incoming('m2', T0 + 1000);

    await waitFor(() => expect(screen.getAllByLabelText('1 条未读').length).toBeGreaterThan(0));
    expect(readCalls()).toHaveLength(1);
  });

  it('管理员停在 AI 管理页时不上报已读', async () => {
    mountShell();
    await waitFor(() => expect(readCalls()).toHaveLength(1));

    await goto('AI');
    await screen.findByRole('button', { name: /AI 配置/ });

    await incoming('m2', T0 + 1000);
    expect(readCalls()).toHaveLength(1);
  });

  it('手机端从详情返回会话列表后不上报已读——会话还选着，但人已经看不到了', async () => {
    useMobileViewport();
    mountShell();
    // 手机端首屏停在会话列表，先自己点进详情
    await openFromList();
    await waitFor(() => expect(readCalls()).toHaveLength(1));

    await userEvent.click(screen.getByRole('button', { name: '返回会话列表' }));
    await incoming('m2', T0 + 1000);

    expect(readCalls()).toHaveLength(1);
  });

  it('手机端首次登录停在会话列表时，自动选中的第一条会话不会被清掉未读', async () => {
    useMobileViewport();
    convos = [conversation({ unread: 2 })];
    mountShell();

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/messages'))).toBe(true));
    await waitFor(() => expect(screen.getAllByLabelText('2 条未读').length).toBeGreaterThan(0));
    expect(readCalls()).toHaveLength(0);
  });

  it('浏览器标签页隐藏时不上报已读', async () => {
    vi.spyOn(Object.getPrototypeOf(document), 'hidden' as never, 'get').mockReturnValue(true);
    mountShell();

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/messages'))).toBe(true));
    await incoming('m2', T0 + 1000);

    expect(readCalls()).toHaveLength(0);
  });
});

describe('重新回到聊天详情（issue #20）', () => {
  it('从联系人页切回详情，补报一次已读——只补一次', async () => {
    mountShell();
    await waitFor(() => expect(readCalls()).toHaveLength(1));

    await goto('联系人');
    await screen.findByPlaceholderText('搜索姓名或邮箱');
    await incoming('m2', T0 + 1000);
    expect(readCalls()).toHaveLength(1);

    await goto(/会话$/);
    await waitFor(() => expect(readCalls()).toHaveLength(2));
    // 补报的位置是那条已经渲染出来的新消息
    expect(readCalls()[1].body).toEqual({ upTo: T0 + 1000 });

    // 再等一会儿也不会冒出第三次
    await new Promise((r) => setTimeout(r, 60));
    expect(readCalls()).toHaveLength(2);
  });

  it('手机端重新进入详情也会补报一次', async () => {
    useMobileViewport();
    mountShell();
    await openFromList();
    await waitFor(() => expect(readCalls()).toHaveLength(1));

    await userEvent.click(screen.getByRole('button', { name: '返回会话列表' }));
    await incoming('m2', T0 + 1000);
    expect(readCalls()).toHaveLength(1);

    await openFromList();
    await waitFor(() => expect(readCalls()).toHaveLength(2));
    expect(readCalls()[1].body).toEqual({ upTo: T0 + 1000 });
  });
});

describe('人确实停在聊天详情时（issue #20 不能把功能修没）', () => {
  it('桌面端：新消息仍然立刻标记为已读，位置就是这条新消息', async () => {
    mountShell();
    await waitFor(() => expect(readCalls()).toHaveLength(1));

    await incoming('m2', T0 + 1000);

    await waitFor(() => expect(readCalls()).toHaveLength(2));
    expect(readCalls()[1].body).toEqual({ upTo: T0 + 1000 });
  });

  it('手机端停在详情里：新消息同样立刻标记为已读', async () => {
    useMobileViewport();
    mountShell();
    await openFromList();
    await waitFor(() => expect(readCalls()).toHaveLength(1));

    await incoming('m2', T0 + 1000);
    await waitFor(() => expect(readCalls()).toHaveLength(2));
  });

  it('已读位置取的是渲染出来的最后一条，不是「服务端的此刻」', async () => {
    history = [message('m1', { createdAt: T0 - 5000 })];
    mountShell();
    await waitFor(() => expect(readCalls()).toHaveLength(1));
    expect(readCalls()[0].body).toEqual({ upTo: T0 - 5000 });
  });
});
