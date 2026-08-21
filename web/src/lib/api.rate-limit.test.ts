// 服务端限流（429）时，ApiError 要把 retryAfterMs / serverNow 带回来，
// 界面才说得出「几点几分可以再发」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, clearToken } from './api';

const respondWith = (status: number, payload: unknown) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(payload),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

beforeEach(() => clearToken());
afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe('429 限流响应', () => {
  it('把 retryAfterMs 和 serverNow 带进 ApiError', async () => {
    respondWith(429, {
      error: '消息发得太快了，请稍后再试',
      scope: 'message',
      retryAfterMs: 42_000,
      serverNow: 1_760_000_000_000,
    });

    const err = await api.sendMessage('c1', '刷屏').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.status).toBe(429);
    expect(apiError.message).toBe('消息发得太快了，请稍后再试');
    expect(apiError.retryAfterMs).toBe(42_000);
    expect(apiError.serverNow).toBe(1_760_000_000_000);
  });

  it('@AI 那一档也一样带回来（scope 不同不影响这条链路）', async () => {
    respondWith(429, { error: '@Aria 太频繁了，请稍后再试', scope: 'ai', retryAfterMs: 180_000 });
    const err = (await api.sendMessage('c1', '@Aria 再问一次').catch((e: unknown) => e)) as ApiError;
    expect(err.retryAfterMs).toBe(180_000);
    expect(err.serverNow).toBeUndefined();
  });

  it('普通失败不会凭空多出 retryAfterMs', async () => {
    respondWith(400, { error: '消息不能为空' });
    const err = (await api.sendMessage('c1', '  ').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(400);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('字段类型不对时当作没有，不把字符串塞进去算时间', async () => {
    respondWith(429, { error: '太快了', retryAfterMs: '42000' });
    const err = (await api.sendMessage('c1', '刷屏').catch((e: unknown) => e)) as ApiError;
    expect(err.retryAfterMs).toBeUndefined();
  });
});
