import type {
  AiOverview, AiProfileDetail, AiPublicInfo, AiSettings, Conversation, Message, MessagePage, User,
} from './types';

const TOKEN_KEY = 'loop-im-token';

// 勾选"保持登录"才写 localStorage（关掉浏览器也在）；不勾选时写 sessionStorage，
// 当前标签页内刷新仍然有效，标签页一关凭据就没了。
export const getToken = () => localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
/** 当前这张凭据是不是「保持登录」那一档（换发 token 时要沿用同一种存储）。 */
export const isRemembered = () => localStorage.getItem(TOKEN_KEY) !== null;
export const clearToken = () => {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
};
export const setToken = (token: string, remember = true) => {
  clearToken();                               // 先清掉另一种存储里的旧凭据，避免切换模式时残留
  (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
};

// 图片体积上限，和服务端 upload-middleware.js 保持一致。
export const MAX_UPLOAD_MB = 8;
export const OVERSIZED_MESSAGE = `图片大小不能超过 ${MAX_UPLOAD_MB}MB`;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 上传前先在本地卡一道体积，超限就不必白跑一趟服务端。 */
function checkSize(file: File) {
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) throw new ApiError(413, OVERSIZED_MESSAGE);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');

  const res = await fetch(`/api${path}`, { ...init, headers });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event('loop-im:signed-out'));
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data.error || `请求失败（${res.status}）`);
  return data as T;
}

export const api = {
  login: (email: string, password: string, remember = true) =>
    request<{ token: string; tokenDays: number; user: User; ai: AiPublicInfo }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, remember }),
    }),
  logout: () => request<{ ok: true; online: boolean }>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User; ai: AiPublicInfo }>('/auth/me'),
  ping: () => request<{ online: boolean; users: User[] }>('/auth/ping', { method: 'POST' }),
  updateName: (name: string) =>
    request<{ user: User }>('/auth/me', { method: 'PATCH', body: JSON.stringify({ name }) }),
  uploadAvatar: (file: File) => {
    checkSize(file);
    const form = new FormData();
    form.append('file', file);
    return request<{ user: User }>('/auth/me/avatar', { method: 'POST', body: form });
  },
  // 改密码会让旧凭据全部失效，服务端顺手换发一张新的，当前这台设备继续保持登录。
  changePassword: async (current: string, next: string) => {
    const res = await request<{ ok: true; token: string; tokenDays: number }>('/auth/me/password', {
      method: 'POST',
      body: JSON.stringify({ current, next }),
    });
    // 改密码会换发 token，沿用原来的存储模式，别把「不保持登录」升级成长期保存。
    setToken(res.token, isRemembered());
    return res;
  },

  users: () => request<{ users: User[] }>('/users'),
  addUser: (payload: { name: string; email: string; dept: string }) =>
    request<{ user: User; initialPassword: string }>('/users', { method: 'POST', body: JSON.stringify(payload) }),

  conversations: () => request<{ conversations: Conversation[] }>('/conversations'),
  conversation: (id: string) => request<{ conversation: Conversation }>(`/conversations/${id}`),
  createGroup: (title: string, memberIds: string[]) =>
    request<{ conversation: Conversation }>('/conversations/group', {
      method: 'POST',
      body: JSON.stringify({ title, memberIds }),
    }),
  openDirect: (userId: string) =>
    request<{ conversation: Conversation }>('/conversations/direct', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  aiContext: (id: string) => request<{ line: string }>(`/conversations/${id}/ai-context`),
  // 默认只取最新一页；翻历史时把上一页最早那条的 id 作为 before 传回来。
  messages: (id: string, opts: { before?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.before) q.set('before', opts.before);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return request<MessagePage>(`/conversations/${id}/messages${qs ? `?${qs}` : ''}`);
  },
  // 上报已读位置。省略 upTo 就按服务端的此刻算。
  markRead: (id: string, upTo?: number) =>
    request<{ conversationId: string; lastReadAt: number; unread: number }>(`/conversations/${id}/read`, {
      method: 'POST',
      body: JSON.stringify(upTo ? { upTo } : {}),
    }),
  sendMessage: (id: string, body: string) =>
    request<{ message: Message }>(`/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  upload: (file: File) => {
    checkSize(file);
    const form = new FormData();
    form.append('file', file);
    return request<{ url: string; filename: string; storage: string }>('/uploads', { method: 'POST', body: form });
  },

  aiSettings: () => request<AiSettings>('/ai/settings'),
  saveAiSettings: (patch: Record<string, unknown>) =>
    request<AiSettings>('/ai/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  testAi: () => request<{ ok: boolean; message: string }>('/ai/test', { method: 'POST' }),
  aiOverview: () => request<AiOverview>('/ai/overview'),
  aiProfile: (userId: string) => request<AiProfileDetail>(`/ai/profiles/${userId}`),
};
