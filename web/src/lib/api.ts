import type {
  AgentsStatus, AgentStep, Conversation, Message, MessagePage,
  MessageReaction, MessageSearchPage, UploadResult, User,
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

/**
 * 站内附件地址补上凭据。
 *
 * /uploads 从「谁都能下载」改成了「该附件所在会话的成员才能下载」，可是 <img src> 和
 * <a href> 都没法带 Authorization 头 —— 只能把 token 放进查询串，和 /api/stream 的
 * EventSource 一个路子（服务端 auth.js 的 readToken 两种都认）。
 *
 * 代价说清楚：token 会因此出现在浏览器历史和服务端访问日志里。同源请求所以不会外泄给
 * 第三方，但这确实比放在头里弱。彻底的解法是发一张只对单个对象、只活几分钟的下载票据，
 * 那是另一件事，这里没做。
 *
 * 没登录时原样返回，不拼一个空 token 上去（测试环境和登录页都会走到这条分支）。
 */
export const attachmentUrl = (url: string) => {
  if (!/^\/uploads\//i.test(url)) return url;
  const token = getToken();
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
};

// 附件体积上限，和服务端 upload-middleware.js 保持一致（图片和普通文件共用同一档）。
export const MAX_UPLOAD_MB = 8;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const OVERSIZED_MESSAGE = `文件大小不能超过 ${MAX_UPLOAD_MB}MB`;

// 视频单独一档：一段能看的录屏动辄几十 MB，8MB 这一档根本发不出去。
// 图片和普通文件仍然是上面那一档，语义没有变。
export const MAX_VIDEO_UPLOAD_MB = 100;
export const MAX_VIDEO_UPLOAD_BYTES = MAX_VIDEO_UPLOAD_MB * 1024 * 1024;
export const VIDEO_OVERSIZED_MESSAGE = `视频大小不能超过 ${MAX_VIDEO_UPLOAD_MB}MB`;

/** 本地预检该按哪一档卡体积。 */
export interface UploadLimit {
  bytes: number;
  message: string;
}

/**
 * 上传前的体积分档。
 *
 * 这里只能看浏览器给的 MIME —— 它是可以谎报的，所以这个判断**不是**安全边界，
 * 只是「别让用户白等一趟」的预检。真正算数的仍然是服务端：它按真实字节判定通道，
 * 谎称 video/mp4 的大文件到了服务端照样会被拒。
 */
export const uploadLimitFor = (file: File): UploadLimit => (
  /^video\//i.test(file.type)
    ? { bytes: MAX_VIDEO_UPLOAD_BYTES, message: VIDEO_OVERSIZED_MESSAGE }
    : { bytes: MAX_UPLOAD_BYTES, message: OVERSIZED_MESSAGE }
);

export class ApiError extends Error {
  status: number;
  /**
   * 服务端限流（429）时才有：**相对**毫秒，表示还要等多久。
   * 界面上的「几点几分可以再发」必须用它在本地换算（`Date.now() + retryAfterMs`），
   * 不能显示服务端算好的绝对时刻——客户端的钟可能偏几分钟，照搬过来就是错的。
   * serverNow 是服务端此刻的时间戳，只用来排查时差，不要拿去显示。
   */
  retryAfterMs?: number;
  serverNow?: number;
  constructor(status: number, message: string, extra: { retryAfterMs?: number; serverNow?: number } = {}) {
    super(message);
    this.status = status;
    this.retryAfterMs = extra.retryAfterMs;
    this.serverNow = extra.serverNow;
  }
}

/**
 * 上传前先在本地卡一道体积，超限就不必白跑一趟服务端。
 * 严格大于：界面文案是「不超过 8MB」，正好 8MB 属于合法范围，要放行。
 * 服务端 multer 的 limits.fileSize 因此写成 上限 + 1（busboy 是「不得达到」语义），
 * 否则这一档会前端放行、服务端 413，白跑一趟——正是本地拦截要避免的。见 issue #15。
 *
 * 按档位卡（见 maxBytesForFile）：视频 100MB，其余仍然是 8MB。
 */
function checkSize(file: File, limit: UploadLimit = { bytes: MAX_UPLOAD_BYTES, message: OVERSIZED_MESSAGE }) {
  if (file.size > limit.bytes) throw new ApiError(413, limit.message);
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
  if (!res.ok) {
    throw new ApiError(res.status, data.error || `请求失败（${res.status}）`, {
      retryAfterMs: typeof data.retryAfterMs === 'number' ? data.retryAfterMs : undefined,
      serverNow: typeof data.serverNow === 'number' ? data.serverNow : undefined,
    });
  }
  return data as T;
}

export const api = {
  login: (email: string, password: string, remember = true) =>
    request<{ token: string; tokenDays: number; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, remember }),
    }),
  logout: () => request<{ ok: true; online: boolean }>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/auth/me'),
  ping: () => request<{ online: boolean; users: User[] }>('/auth/ping', { method: 'POST' }),
  updateName: (name: string) =>
    request<{ user: User }>('/auth/me', { method: 'PATCH', body: JSON.stringify({ name }) }),
  uploadAvatar: (file: File) => {
    // 头像永远是 8MB 那一档：它只收图片，视频那档 100MB 的放宽和它无关。
    // 不传 limit，用的就是默认那一档（服务端的头像口也单独锁死在 8MB）。
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

  // 列表和消息都接受取消信号：退出登录或组件卸载时，在途的这几个请求要能立刻掐掉，
  // 否则它们会带着已经作废的凭据回来一个 401（见 issue #21）。
  users: (opts: { signal?: AbortSignal } = {}) => request<{ users: User[] }>('/users', { signal: opts.signal }),
  addUser: (payload: { name: string; email: string; dept: string }) =>
    request<{ user: User; initialPassword: string }>('/users', { method: 'POST', body: JSON.stringify(payload) }),

  conversations: (opts: { signal?: AbortSignal } = {}) =>
    request<{ conversations: Conversation[] }>('/conversations', { signal: opts.signal }),
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
  addMembers: (id: string, userIds: string[]) =>
    request<{ conversation: Conversation }>(`/conversations/${id}/members`, {
      method: 'POST',
      body: JSON.stringify({ userIds }),
    }),
  removeMember: (id: string, userId: string) =>
    request<{ conversation: Conversation }>(`/conversations/${id}/members/${userId}`, { method: 'DELETE' }),
  renameConversation: (id: string, title: string) =>
    request<{ conversation: Conversation }>(`/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  leaveConversation: (id: string) =>
    request<{ ok: true }>(`/conversations/${id}/leave`, { method: 'POST' }),
  // 置顶 / 免打扰：都是「我对这个会话」的个人设置，服务端只改 conversation_members 里
  // 我自己那一行，别人看到的顺序和提醒方式不受影响。两项可分开改也可一起改。
  updateConversationPrefs: (id: string, prefs: { pinned?: boolean; muted?: boolean }) =>
    request<{ conversation: Conversation }>(`/conversations/${id}/prefs`, {
      method: 'PATCH',
      body: JSON.stringify(prefs),
    }),
  // 默认只取最新一页；翻历史时把上一页最早那条的 id 作为 before 传回来。
  messages: (id: string, opts: { before?: string; limit?: number; signal?: AbortSignal } = {}) => {
    const q = new URLSearchParams();
    if (opts.before) q.set('before', opts.before);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return request<MessagePage>(`/conversations/${id}/messages${qs ? `?${qs}` : ''}`, { signal: opts.signal });
  },
  // 上报已读位置。省略 upTo 就按服务端的此刻算。
  markRead: (id: string, upTo?: number) =>
    request<{ conversationId: string; lastReadAt: number; unread: number }>(`/conversations/${id}/read`, {
      method: 'POST',
      body: JSON.stringify(upTo ? { upTo } : {}),
    }),
  // 全文搜消息。省略 conversationId 就是全局搜（服务端只会给出我是成员的那些会话）。
  // 翻页同样用 before 游标：把上一页 nextBefore 传回来。
  searchMessages: (q: string, opts: { conversationId?: string; limit?: number; before?: string } = {}) => {
    const params = new URLSearchParams({ q });
    if (opts.conversationId) params.set('conversationId', opts.conversationId);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.before) params.set('before', opts.before);
    return request<MessageSearchPage>(`/messages/search?${params.toString()}`);
  },
  // replyTo 是被引用消息的 id。不引用时整个字段都不带上，请求体保持原样。
  sendMessage: (id: string, body: string, replyTo?: string | null) =>
    request<{ message: Message }>(`/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(replyTo ? { body, replyTo } : { body }),
    }),
  // 表情回应：加和取消是两个接口，各自幂等（重复点不会多出一条，没点过时取消也不报错）。
  // 两者都返回这条消息回应的最新聚合，直接拿去替换本地那一份即可。
  addReaction: (conversationId: string, messageId: string, emoji: string) =>
    request<{ messageId: string; reactions: MessageReaction[] }>(
      `/conversations/${conversationId}/messages/${messageId}/reactions`,
      { method: 'POST', body: JSON.stringify({ emoji }) },
    ),
  // 表情走查询串而不是请求体：DELETE 带 body 在中间层里不一定活得下来。
  removeReaction: (conversationId: string, messageId: string, emoji: string) =>
    request<{ messageId: string; reactions: MessageReaction[] }>(
      `/conversations/${conversationId}/messages/${messageId}/reactions?emoji=${encodeURIComponent(emoji)}`,
      { method: 'DELETE' },
    ),
  // 图片、视频和普通文件走同一个入口，由服务端按真实字节判定 kind
  //（image 可内联、video 可内联播放、file 只能下载）。体积上限按类型分档，见 uploadLimitFor。
  upload: (file: File) => {
    checkSize(file, uploadLimitFor(file));
    const form = new FormData();
    form.append('file', file);
    return request<UploadResult>('/uploads', { method: 'POST', body: form });
  },

  // 管理员重置成员密码：新密码只在这次响应里回来一次，界面显示完就没了。
  // 该成员所有设备上的登录会同时失效。
  resetUserPassword: (userId: string) =>
    request<{ user: User; password: string }>(`/users/${userId}/reset-password`, { method: 'POST' }),

  // 停用 / 恢复成员账号。停用同样会让该成员所有设备上的登录立刻失效（连 SSE 长连接
  // 一起断），但聊天记录、群成员身份、名字头像一律留着——停用不是删除。
  setUserDisabled: (userId: string, disabled: boolean) =>
    request<{ user: User }>(`/users/${userId}/${disabled ? 'disable' : 'enable'}`, { method: 'POST' }),

  // ── Web Push ────────────────────────────────────────────────────────────
  // 公钥必须在运行时问服务端要，不能编译进前端：每套部署的 VAPID 密钥都不一样。
  // 服务端没配 VAPID 时返回 { enabled: false, publicKey: null }，前端据此整条路径跳过，
  // 而不是让用户点了开关之后对着一个永远失败的订阅发呆。
  pushConfig: () => request<{ enabled: boolean; publicKey: string | null }>('/push/config'),
  // upsert 语义：同一个 endpoint 反复上报只会有一行，所以前端可以每次启动都无脑调一次
  //（iOS 收不到 pushsubscriptionchange，只能靠这个兜住失效的订阅，见 lib/push.ts）。
  pushSubscribe: (payload: {
    deviceId: string;
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  }) => request<{ ok: true }>('/push/subscribe', { method: 'POST', body: JSON.stringify(payload) }),
  // 退订走请求体带 endpoint 的 DELETE。服务端只删自己名下那条（WHERE endpoint AND user_id），
  // 否则谁都能拿别人的 endpoint 把别人的推送关掉。成功是 204，没有响应体。
  pushUnsubscribe: (endpoint: string) =>
    request<Record<string, never>>('/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint }) }),
  /**
   * 上报「本页面此刻在不在前台」。服务端靠它决定这台设备该不该收推送 ——
   * **不再**拿 SSE 连接在不在去猜（iOS 冻结 PWA 时 TCP 不会立刻断，猜出来是错的）。
   *
   * `keepalive: true` 是这条请求的**要害**，不是优化：它专为「页面正在离开 / 即将被
   * 冻结」设计，请求交给浏览器的网络栈，页面冻住也照样发完。而「我切后台了」这一发
   * 恰恰就是在页面即将被冻结的那一刻发出去的 —— 少了它，最该送到的那一条最先丢。
   *
   * ⚠️ 不要改成 `navigator.sendBeacon`：它带不了 `Authorization` 头，这个接口要鉴权。
   */
  pushVisibility: (payload: { deviceId: string; streamId: string; visible: boolean }) =>
    request<{ ok: true; connections: number }>('/push/visibility', {
      method: 'POST',
      body: JSON.stringify(payload),
      keepalive: true,
    }),

  /** Agent 回复的执行过程步子（D15）：点开过程行才拉，列表只带步数。 */
  messageSteps: (conversationId: string, messageId: string) =>
    request<{ steps: AgentStep[] }>(`/conversations/${conversationId}/messages/${messageId}/steps`),

  // ---- hapi Agent 管理（管理员） ----
  agentsStatus: () => request<AgentsStatus>('/agents'),
  setAgentEnabled: (key: string, enabled: boolean) =>
    request<{ ok: true }>(`/agents/${key}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  renameAgent: (key: string, name: string) =>
    request<{ ok: true }>(`/agents/${key}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  testAgents: () => request<{ ok: boolean; lines: string[] }>('/agents/test', { method: 'POST' }),
};
