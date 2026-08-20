// issue #21：主动退出登录时，在途请求会变成未处理的页面错误「登录已过期，请重新登录」。
// 服务端一删掉当前 session，同一凭据的在途请求就返回 401；api 层清完登录态还会继续把错误抛出来，
// 而 AppShell 里那些 `void refreshUsers()` 没人接。慢网下稳定复现。
// 这里锁住的是：退出时先停手（实时连接、心跳、在途请求），401 与取消都被正常消费掉，
// 但真正的凭据过期仍然要把用户送回登录页。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { AppShell } from './AppShell';
import type { StreamHandlers } from './lib/useStream';
import type { AiPublicInfo, Conversation, Message, User } from './lib/types';

let handlers: StreamHandlers = {};
let streamEnabled = false;
vi.mock('./lib/useStream', () => ({
  useStream: (enabled: boolean, h: StreamHandlers) => { streamEnabled = enabled; handlers = h; },
}));

const ME: User = {
  id: 'u_lin', name: '林悦', email: 'lin@loop.dev', dept: '产品',
  role: 'member', avatarUrl: null, isAI: false, online: true,
};
const PEER: User = { ...ME, id: 'u_chen', name: '陈子航', email: 'c@loop.dev', dept: '后端' };
const AI: AiPublicInfo = { name: 'Aria', providerLabel: '模拟供应商', silentRead: false, allowDm: true };

// 用单聊：群聊还会额外拉一次 AI 上下文，与本 issue 无关，别混进请求断言里。
const CONVERSATION: Conversation = {
  id: 'c1',
  type: 'dm',
  title: '陈子航',
  peerId: PEER.id,
  createdBy: ME.id,
  members: [ME, PEER].map((m) => ({ ...m, roleInGroup: m.dept })),
  lastMessage: null,
  unread: 0,
};

const MESSAGE: Message = {
  id: 'm1',
  conversationId: 'c1',
  senderId: PEER.id,
  senderName: PEER.name,
  senderAvatarUrl: null,
  body: '内容 m1',
  mentions: [],
  createdAt: 1_700_000_000_000,
  isAI: false,
};

interface Call { url: string; method: string; auth: string | null; signal: AbortSignal | null }

let calls: Call[];
let usersStatus: number;
let logoutReply: () => Response;
let unhandled: unknown[];
let pending: Record<string, Promise<void>>;

const json = (body: unknown, status = 200) => ({
  ok: status < 400, status, text: async () => JSON.stringify(body),
}) as Response;
const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

/**
 * 给某个接口注入延迟——issue 里就是靠给 GET /api/users 加 900ms 稳定复现的。
 * 返回「放行」函数：调用它，这个请求才回来。
 */
function delay(path: string) {
  let done = () => {};
  pending[path] = new Promise<void>((resolve) => { done = resolve; });
  return () => {
    delete pending[path];
    done();
  };
}

/** 真实的 fetch 在请求被 abort 时会抛 AbortError，桩也得照做，否则测不出取消。 */
function abortable<T>(init: RequestInit, work: Promise<T>): Promise<T> {
  const signal = init.signal;
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// 「未处理的页面错误」在 jsdom 里落到 Node 的 unhandledRejection 上。
// web 这边没装 @types/node，所以自己描述一下要用的那两个方法。
type RejectionHook = (event: 'unhandledRejection', cb: (reason: unknown) => void) => void;
const nodeProcess = (globalThis as unknown as { process: { on: RejectionHook; off: RejectionHook } }).process;
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

/** 让微任务和 Node 的 unhandledRejection 上报都跑完，再看有没有漏网的错误。 */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

beforeEach(() => {
  handlers = {};
  streamEnabled = false;
  calls = [];
  pending = {};
  unhandled = [];
  usersStatus = 200;
  logoutReply = () => json({ ok: true, online: false });
  localStorage.setItem('loop-im-token', 'test-token');
  nodeProcess.on('unhandledRejection', onUnhandled);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method || 'GET', auth: headers.get('Authorization'), signal: init.signal ?? null });
    const gate = pending[url];
    if (gate) await abortable(init, gate);
    if (url === '/api/auth/logout') return logoutReply();
    if (url === '/api/auth/me') return json({ user: ME, ai: AI });
    if (url === '/api/users') {
      return usersStatus === 401
        ? json({ error: '登录已过期，请重新登录' }, 401)
        : json({ users: [ME, PEER] });
    }
    if (url === '/api/conversations') return json({ conversations: [CONVERSATION] });
    if (url.endsWith('/messages')) return json({ messages: [MESSAGE], hasMore: false, nextBefore: null, reads: [] });
    return json({});
  }));
});

afterEach(() => {
  cleanup();
  nodeProcess.off('unhandledRejection', onUnhandled);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const shell = (onSignOut: () => void) => render(
  <AppShell me={ME} ai={AI} theme="light" onToggleTheme={vi.fn()} onSignOut={onSignOut} justSignedIn={false} />,
);

/** 进「我」→ 点退出登录。 */
async function signOut() {
  await userEvent.click(await screen.findByTitle('个人资料'));
  await userEvent.click(await screen.findByRole('button', { name: '退出登录' }));
}

describe('主动退出时的在途请求（issue #21）', () => {
  it('给联系人 / 消息请求注入延迟后退出：回到登录页，且没有未处理错误', async () => {
    const releaseUsers = delay('/api/users');
    const releaseMessages = delay('/api/conversations/c1/messages');
    render(<App />);
    await screen.findByTitle('个人资料');

    await signOut();
    expect(await screen.findByText('登录 Loop IM')).toBeInTheDocument();

    // 服务端此时已经销毁了 session：在途请求这会儿才回来，回来的是 401
    usersStatus = 401;
    releaseUsers();
    releaseMessages();
    await settle();

    expect(unhandled).toEqual([]);
  });

  it('退出时在途的列表请求被明确取消', async () => {
    delay('/api/users');
    render(<App />);
    await waitFor(() => expect(calls.some((c) => c.url === '/api/users')).toBe(true));
    const usersCall = calls.find((c) => c.url === '/api/users')!;
    expect(usersCall.signal).not.toBeNull();

    await signOut();
    await waitFor(() => expect(usersCall.signal?.aborted).toBe(true));
    expect(unhandled).toEqual([]);
  });

  it('退出等待期间收到实时事件：实时连接已断开，不再发出新请求', async () => {
    // 上层还在等退出接口返回，AppShell 这时仍然挂着
    shell(vi.fn());
    await waitFor(() => expect(streamEnabled).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/conversations')).toBe(true));

    await signOut();
    await waitFor(() => expect(streamEnabled).toBe(false));

    const before = calls.length;
    await act(async () => {
      handlers.onMessage?.({ ...MESSAGE, id: 'm2', createdAt: MESSAGE.createdAt + 1000 });
      handlers.onPresence?.(PEER.id, false);
      handlers.onUserChanged?.(PEER);
    });
    await settle();

    expect(calls.slice(before).map((c) => c.url)).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});

describe('退出本身仍然要办成的事（issue #21）', () => {
  it('退出请求带着凭据发出，别人才会立刻看到该用户离线', async () => {
    render(<App />);
    await signOut();

    await waitFor(() => expect(calls.some((c) => c.url === '/api/auth/logout')).toBe(true));
    const logout = calls.find((c) => c.url === '/api/auth/logout')!;
    expect(logout.method).toBe('POST');
    expect(logout.auth).toBe('Bearer test-token');
  });

  it('退出接口 500 时本地照样退出，且没有未处理错误', async () => {
    logoutReply = () => json({ error: '服务器开小差了' }, 500);
    render(<App />);
    await signOut();

    expect(await screen.findByText('登录 Loop IM')).toBeInTheDocument();
    await settle();
    expect(localStorage.getItem('loop-im-token')).toBeNull();
    expect(unhandled).toEqual([]);
  });

  it('退出接口断网时本地照样退出，且没有未处理错误', async () => {
    logoutReply = () => { throw new Error('network down'); };
    render(<App />);
    await signOut();

    expect(await screen.findByText('登录 Loop IM')).toBeInTheDocument();
    await settle();
    expect(localStorage.getItem('loop-im-token')).toBeNull();
    expect(unhandled).toEqual([]);
  });
});

describe('凭据自然过期（issue #21 不能连这个也一起吞掉）', () => {
  it('后台刷新拿到 401 时把用户送回登录页，同时不留下未处理错误', async () => {
    usersStatus = 401;
    render(<App />);

    expect(await screen.findByText('登录 Loop IM')).toBeInTheDocument();
    await settle();
    expect(localStorage.getItem('loop-im-token')).toBeNull();
    expect(unhandled).toEqual([]);
  });
});
