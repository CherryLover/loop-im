// api 层：这一轮新增的接口调用是否按约定拼请求。
// 这些方法之前没有直接测试，路径或方法拼错只有跑起来才发现。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, clearToken, setToken } from './api';

let fetchMock: ReturnType<typeof vi.fn>;

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
};

beforeEach(() => {
  clearToken();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe('消息分页', () => {
  it('不带参数时就是干净的路径，没有多余的问号', async () => {
    await api.messages('c1');
    expect(lastCall().url).toBe('/api/conversations/c1/messages');
  });

  it('带游标和条数时拼进查询串', async () => {
    await api.messages('c1', { before: 'm_9', limit: 20 });
    const { url } = lastCall();
    expect(url).toContain('before=m_9');
    expect(url).toContain('limit=20');
  });

  it('游标里的特殊字符会被转义', async () => {
    await api.messages('c1', { before: 'm/9 ?&=' });
    expect(lastCall().url).toContain('before=m%2F9+%3F%26%3D');
  });

  it('只给其中一个参数时不会带上另一个', async () => {
    await api.messages('c1', { before: 'm_1' });
    expect(lastCall().url).not.toContain('limit=');
  });
});

describe('已读上报', () => {
  it('不传 upTo 时发空对象，交给服务端按此刻算', async () => {
    await api.markRead('c1');
    const { url, method, body } = lastCall();
    expect(url).toBe('/api/conversations/c1/read');
    expect(method).toBe('POST');
    expect(body).toEqual({});
  });

  it('传了 upTo 就带上', async () => {
    await api.markRead('c1', 1_700_000_000_000);
    expect(lastCall().body).toEqual({ upTo: 1_700_000_000_000 });
  });
});

describe('群管理', () => {
  it('添加成员：POST /members，带 userIds', async () => {
    await api.addMembers('c1', ['u_a', 'u_b']);
    const { url, method, body } = lastCall();
    expect(url).toBe('/api/conversations/c1/members');
    expect(method).toBe('POST');
    expect(body).toEqual({ userIds: ['u_a', 'u_b'] });
  });

  it('移除成员：DELETE /members/:userId', async () => {
    await api.removeMember('c1', 'u_a');
    const { url, method } = lastCall();
    expect(url).toBe('/api/conversations/c1/members/u_a');
    expect(method).toBe('DELETE');
  });

  it('改群名：PATCH 会话本身', async () => {
    await api.renameConversation('c1', '新名字');
    const { url, method, body } = lastCall();
    expect(url).toBe('/api/conversations/c1');
    expect(method).toBe('PATCH');
    expect(body).toEqual({ title: '新名字' });
  });

  it('退群：POST /leave', async () => {
    await api.leaveConversation('c1');
    const { url, method } = lastCall();
    expect(url).toBe('/api/conversations/c1/leave');
    expect(method).toBe('POST');
  });
});

describe('通用行为', () => {
  it('有凭据时带上 Authorization 头', async () => {
    setToken('tok-123');
    await api.markRead('c1');
    const headers = lastCall().init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer tok-123');
  });

  it('服务端报错时抛出带状态码和原因的 ApiError', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 403, text: async () => JSON.stringify({ error: '只有群主或管理员可以移除成员' }),
    });
    await expect(api.removeMember('c1', 'u_a')).rejects.toMatchObject({
      status: 403,
      message: '只有群主或管理员可以移除成员',
    });
  });

  it('401 会清掉本地凭据并广播登出事件', async () => {
    setToken('tok-123');
    const onSignedOut = vi.fn();
    window.addEventListener('loop-im:signed-out', onSignedOut);
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => JSON.stringify({ error: '未登录' }) });

    await expect(api.markRead('c1')).rejects.toThrow();
    expect(onSignedOut).toHaveBeenCalled();
    expect(localStorage.getItem('loop-im-token')).toBeNull();
    window.removeEventListener('loop-im:signed-out', onSignedOut);
  });
});
