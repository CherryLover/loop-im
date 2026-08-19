import type {
  AiOverview, AiProfileDetail, AiPublicInfo, AiSettings, Conversation, Message, User,
} from './types';

const TOKEN_KEY = 'loop-im-token';

// 勾选"保持登录"才写 localStorage（关掉浏览器也在）；不勾选时写 sessionStorage，
// 当前标签页内刷新仍然有效，标签页一关凭据就没了。
export const getToken = () => localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
export const clearToken = () => {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
};
export const setToken = (token: string, remember = true) => {
  clearToken();                               // 先清掉另一种存储里的旧凭据，避免切换模式时残留
  (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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
  me: () => request<{ user: User; ai: AiPublicInfo }>('/auth/me'),
  ping: () => request<{ online: boolean; users: User[] }>('/auth/ping', { method: 'POST' }),
  updateName: (name: string) =>
    request<{ user: User }>('/auth/me', { method: 'PATCH', body: JSON.stringify({ name }) }),
  uploadAvatar: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ user: User }>('/auth/me/avatar', { method: 'POST', body: form });
  },
  changePassword: (current: string, next: string) =>
    request<{ ok: true }>('/auth/me/password', { method: 'POST', body: JSON.stringify({ current, next }) }),

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
  messages: (id: string) => request<{ messages: Message[] }>(`/conversations/${id}/messages`),
  sendMessage: (id: string, body: string) =>
    request<{ message: Message }>(`/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  upload: (file: File) => {
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
