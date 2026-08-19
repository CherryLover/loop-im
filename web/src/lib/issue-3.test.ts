// issue #3：取消"保持登录"仍会长期保持登录。
// 勾选时凭据落 localStorage，不勾选时只进 sessionStorage（关掉标签页即失效）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, clearToken, getToken, setToken } from './api';

const TOKEN_KEY = 'loop-im-token';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const jsonResponse = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

/** 用假 fetch 记录每次请求的 init，方便断言请求体。 */
function stubFetch(status: number, data: unknown) {
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push(init);
    return jsonResponse(status, data);
  }));
  return calls;
}

describe('保持登录开关（issue #3）', () => {
  it('勾选保持登录时写 localStorage', () => {
    setToken('tok-remember', true);
    assertOnly('local', 'tok-remember');
    expect(getToken()).toBe('tok-remember');
  });

  it('不勾选时只写 sessionStorage，localStorage 不留凭据', () => {
    setToken('tok-session', false);
    assertOnly('session', 'tok-session');
    expect(getToken()).toBe('tok-session');
  });

  it('两种模式切换时不会残留上一种模式的旧凭据', () => {
    setToken('tok-remember', true);
    setToken('tok-session', false);
    assertOnly('session', 'tok-session');

    setToken('tok-remember-2', true);
    assertOnly('local', 'tok-remember-2');
  });

  it('退出登录时两种存储都被清除', () => {
    localStorage.setItem(TOKEN_KEY, 'tok-remember');
    sessionStorage.setItem(TOKEN_KEY, 'tok-session');
    clearToken();
    expect(localStorage.getItem(TOKEN_KEY)).toBe(null);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(null);
    expect(getToken()).toBe(null);
  });

  it('登录失效（401）时两种存储都被清除', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok-remember');
    sessionStorage.setItem(TOKEN_KEY, 'tok-session');
    stubFetch(401, { error: '登录已过期，请重新登录' });

    await expect(api.me()).rejects.toThrow();
    expect(localStorage.getItem(TOKEN_KEY)).toBe(null);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(null);
  });

  it('登录请求把 remember 传给后端', async () => {
    const calls = stubFetch(200, { token: 't', tokenDays: 1, user: {}, ai: {} });

    await api.login('a@loop.dev', 'pw', false);
    expect(JSON.parse(String(calls[0].body))).toMatchObject({ remember: false });

    await api.login('a@loop.dev', 'pw', true);
    expect(JSON.parse(String(calls[1].body))).toMatchObject({ remember: true });
  });
});

/** 断言凭据只存在于指定的一种存储里。 */
function assertOnly(where: 'local' | 'session', token: string) {
  const kept = where === 'local' ? localStorage : sessionStorage;
  const other = where === 'local' ? sessionStorage : localStorage;
  expect(kept.getItem(TOKEN_KEY)).toBe(token);
  expect(other.getItem(TOKEN_KEY)).toBe(null);
}

// 合并 #2（改密码换发 token）后补的回归：换发不能把「不保持登录」升级成长期保存。
describe('改密码换发 token 时保留存储模式', () => {
  it('会话模式下换发的 token 仍只写 sessionStorage', async () => {
    const { setToken, getToken, isRemembered } = await import('./api');
    setToken('session-token', false);
    expect(isRemembered()).toBe(false);

    setToken('reissued-token', isRemembered());
    expect(sessionStorage.getItem('loop-im-token')).toBe('reissued-token');
    expect(localStorage.getItem('loop-im-token')).toBeNull();
    expect(getToken()).toBe('reissued-token');
  });

  it('保持登录模式下换发的 token 仍写 localStorage', async () => {
    const { setToken, isRemembered } = await import('./api');
    setToken('kept-token', true);
    expect(isRemembered()).toBe(true);

    setToken('reissued-token', isRemembered());
    expect(localStorage.getItem('loop-im-token')).toBe('reissued-token');
    expect(sessionStorage.getItem('loop-im-token')).toBeNull();
  });
});
