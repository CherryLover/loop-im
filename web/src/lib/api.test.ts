// api 层：这一轮新增的接口调用是否按约定拼请求。
// 这些方法之前没有直接测试，路径或方法拼错只有跑起来才发现。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api, clearToken, setToken,
  MAX_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_BYTES, OVERSIZED_MESSAGE, VIDEO_OVERSIZED_MESSAGE, uploadLimitFor,
} from './api';

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

describe('表情回应', () => {
  it('加回应走 POST，表情放在请求体里', async () => {
    await api.addReaction('c1', 'm_1', '👍');
    const { url, method, body } = lastCall();
    expect(url).toBe('/api/conversations/c1/messages/m_1/reactions');
    expect(method).toBe('POST');
    expect(body).toEqual({ emoji: '👍' });
  });

  it('取消走 DELETE，表情转义后放查询串（DELETE 带 body 在中间层里不一定活得下来）', async () => {
    await api.removeReaction('c1', 'm_1', '👍');
    const { url, method, init } = lastCall();
    expect(method).toBe('DELETE');
    expect(url).toBe('/api/conversations/c1/messages/m_1/reactions?emoji=%F0%9F%91%8D');
    expect(init.body).toBeUndefined();
  });

  it('带变体选择符的表情同样被完整转义，不会被截成半个', async () => {
    await api.removeReaction('c1', 'm_1', '❤️');
    expect(lastCall().url).toBe('/api/conversations/c1/messages/m_1/reactions?emoji=%E2%9D%A4%EF%B8%8F');
  });
});

// 体积上限按类型分档：图片和普通文件仍是 8MB，视频单独一档 100MB
//（8MB 装不下一段能看的录屏）。
describe('上传体积分档', () => {
  /** 造一个指定体积的文件，不真的分配那么多内存。 */
  const sized = (name: string, type: string, bytes: number) => {
    const file = new File(['x'], name, { type });
    Object.defineProperty(file, 'size', { value: bytes });
    return file;
  };

  it('视频这一档是 100MB，且比通用那一档大', () => {
    expect(MAX_VIDEO_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_VIDEO_UPLOAD_BYTES).toBeGreaterThan(MAX_UPLOAD_BYTES);
  });

  it('uploadLimitFor 按 MIME 分档', () => {
    expect(uploadLimitFor(sized('a.mp4', 'video/mp4', 1)).bytes).toBe(MAX_VIDEO_UPLOAD_BYTES);
    expect(uploadLimitFor(sized('a.webm', 'video/webm', 1)).bytes).toBe(MAX_VIDEO_UPLOAD_BYTES);
    expect(uploadLimitFor(sized('a.png', 'image/png', 1)).bytes).toBe(MAX_UPLOAD_BYTES);
    expect(uploadLimitFor(sized('a.pdf', 'application/pdf', 1)).bytes).toBe(MAX_UPLOAD_BYTES);
    expect(uploadLimitFor(sized('a.bin', '', 1)).bytes).toBe(MAX_UPLOAD_BYTES);
  });

  // 本地这道拦截是同步抛的（在发请求之前），所以这里断言 throw 而不是 rejects。
  it('20MB 的视频放行（换成图片就会被拦下）', async () => {
    const bytes = 20 * 1024 * 1024;
    await api.upload(sized('录屏.mp4', 'video/mp4', bytes));
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockClear();
    expect(() => api.upload(sized('大图.png', 'image/png', bytes))).toThrow(OVERSIZED_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('超过 100MB 的视频本地就拦下，提示是视频那一档的文案', () => {
    expect(() => api.upload(sized('录屏.mp4', 'video/mp4', MAX_VIDEO_UPLOAD_BYTES + 1)))
      .toThrow(VIDEO_OVERSIZED_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('正好卡在上限上要放行（文案是「不超过」）', async () => {
    await api.upload(sized('录屏.mp4', 'video/mp4', MAX_VIDEO_UPLOAD_BYTES));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('头像那条路不受影响，仍然是通用的 8MB 一档', () => {
    expect(() => api.uploadAvatar(sized('头像.mp4', 'video/mp4', MAX_UPLOAD_BYTES + 1)))
      .toThrow(OVERSIZED_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
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
