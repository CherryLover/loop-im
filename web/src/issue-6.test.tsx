// issue #6：点"退出登录"只清了本地凭证，没有通知服务端，别人还会看到他在线。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

const me = {
  id: 'u_1', name: '林小满', email: 'lin@test.local', dept: '运营',
  role: 'member', avatarUrl: null, isAI: false, online: true,
};
const ai = { name: 'Aria', providerLabel: 'GPT', silentRead: true, allowDm: true };

const json = (body: unknown) => ({
  ok: true, status: 200, text: async () => JSON.stringify(body),
}) as Response;

let calls: { url: string; method: string }[];
let logoutReply: () => Response | never;

beforeEach(() => {
  calls = [];
  logoutReply = () => json({ ok: true });
  localStorage.setItem('loop-im-token', 'test-token');
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  // EventSource 在 jsdom 里不存在，实时通道对本用例无关紧要，给个空壳。
  vi.stubGlobal('EventSource', class {
    addEventListener() {}
    close() {}
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    if (url.endsWith('/api/auth/logout')) return logoutReply();
    if (url.endsWith('/api/auth/me')) return json({ user: me, ai });
    if (url.endsWith('/api/conversations')) return json({ conversations: [] });
    if (url.endsWith('/api/users')) return json({ users: [me] });
    return json({});
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** 进到"我"里点退出登录。 */
async function signOut() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText('我');
  await user.click(screen.getByText('我'));
  await user.click(await screen.findByRole('button', { name: '退出登录' }));
}

describe('主动退出登录（issue #6）', () => {
  it('退出登录会先通知服务端，再清掉本地登录态', async () => {
    await signOut();
    await waitFor(() => expect(screen.getByText('登录 Loop IM')).toBeInTheDocument());
    expect(calls.some((c) => c.url.endsWith('/api/auth/logout') && c.method === 'POST')).toBe(true);
    expect(localStorage.getItem('loop-im-token')).toBe(null);
  });

  it('退出接口失败时，本地照样退出', async () => {
    logoutReply = () => { throw new Error('network down'); };
    await signOut();
    await waitFor(() => expect(screen.getByText('登录 Loop IM')).toBeInTheDocument());
    expect(localStorage.getItem('loop-im-token')).toBe(null);
  });
});
