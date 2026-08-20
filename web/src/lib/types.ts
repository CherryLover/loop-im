export type Role = 'admin' | 'member' | 'ai';

export interface User {
  id: string;
  name: string;
  email: string;
  dept: string;
  role: Role;
  avatarUrl: string | null;
  isAI: boolean;
  online: boolean;
  /**
   * 账号是否已停用（离职等原因）。停用不是删除：这个人照常留在名单、群成员和历史消息里，
   * 只是不能再登录，也恒为离线。老接口没有这个字段时按未停用处理。
   */
  disabled?: boolean;
}

export interface GroupMember extends User {
  roleInGroup: string;
}

/**
 * 被引用消息的摘要，随消息一起下发，前端不必再发一轮请求。
 * 只有一层：被引用的那条自己引了谁，这里不再展开。
 */
export interface MessageQuote {
  senderName: string;
  /** 正文截断后的一行；原消息不可用时是「消息已不可用」。 */
  preview: string;
  /** 原消息还在不在（被删掉、或不属于本会话时为 false）。 */
  available: boolean;
}

/**
 * 一条消息上某一种表情的聚合结果，随消息一起下发（前端不必再发一轮请求）：
 * 谁点了、一共几个、我点没点。mine 是相对当前登录者的。
 */
export interface MessageReaction {
  emoji: string;
  count: number;
  users: { id: string; name: string }[];
  mine: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatarUrl: string | null;
  body: string;
  mentions: string[];
  createdAt: number;
  isAI: boolean;
  pending?: boolean;
  /** user = 普通消息；system = 成员变动、改群名之类的提示。 */
  kind?: 'user' | 'system';
  /** 引用回复指向的原消息 id；没有引用时为 null。老接口没有这个字段。 */
  replyTo?: string | null;
  /** 被引用消息的摘要；没有引用时为 null。 */
  quote?: MessageQuote | null;
  /** 已有的表情回应，按第一个人点的先后排。老接口没有这个字段时按「没有回应」处理。 */
  reactions?: MessageReaction[];
}

/** 输入框上方那块「正在回复某条消息」的引用态。 */
export interface ReplyTarget {
  id: string;
  senderName: string;
  preview: string;
}

/** 某人在某个会话里读到了哪一刻。 */
export interface ReadState {
  userId: string;
  lastReadAt: number;
}

/** 一页消息。nextBefore 是下一页的游标（本页最早那条的 id），没有更早的就是 null。 */
export interface MessagePage {
  messages: Message[];
  hasMore: boolean;
  nextBefore: string | null;
  reads: ReadState[];
}

export type ConversationType = 'group' | 'dm' | 'ai';

export interface Conversation {
  id: string;
  type: ConversationType;
  title: string;
  peerId: string | null;
  /** 建群者。他和系统管理员可以管理成员与群名。 */
  createdBy: string | null;
  members: GroupMember[];
  lastMessage: { preview: string; createdAt: number } | null;
  /** 我在这个会话里的未读条数（不含自己发的）。 */
  unread: number;
  /**
   * 未读里有多少条 @ 到我（含 @全员，不含自己发的）。群一多，@我 很容易淹在
   * 普通未读里，这一档单独拎出来给徽标做区分。老接口没有这个字段时按 0 处理。
   */
  mentionsUnread?: number;
  /**
   * 我把这个会话置顶了没有。这是「我」的个人设置，同一个群对别人可以是未置顶的。
   * 只影响会话列表排序：置顶的整体排在前面，组内仍按最后消息时间倒序。
   * 老接口没有这个字段时按 false 处理。
   */
  pinned?: boolean;
  /**
   * 我把这个会话设为免打扰了没有。同样是「我」的个人设置。
   *
   * 语义只有一条：**不打扰，不是不计数**。消息照收、未读照算、@我 照样统计，
   * muted 只影响「怎么提醒」——不弹桌面通知、会话列表徽标弱化。
   * 千万别拿它去过滤 unread，那是「静音即已读」，是另一回事。
   */
  muted?: boolean;
}

/**
 * 附件走的是哪条通道（服务端按真实字节判定，见 server/src/attachments.js）：
 * image = PNG/JPEG/GIF/WebP，可以内联渲染成图片；
 * file  = 其余任意文件，只能下载，永远不内联。
 */
export type AttachmentKind = 'image' | 'file';

/** POST /api/uploads 的返回。kind/mime 是 issue #22 之后新增的，老服务端不带。 */
export interface UploadResult {
  url: string;
  /** 原始文件名，只作为显示名；它不参与磁盘路径，也不出现在 url 里。 */
  filename: string;
  storage: string;
  kind?: AttachmentKind;
  mime?: string;
}

/** AI facts every signed-in member may see (the full settings are admin-only). */
export interface AiPublicInfo {
  name: string;
  providerLabel: string;
  silentRead: boolean;
  allowDm: boolean;
}

export interface AiProviderOption {
  key: string;
  name: string;
  note: string;
  model: string;
}

export interface AiSettings {
  provider: string;
  hasApiKey: boolean;
  configured: boolean;
  providers: AiProviderOption[];
  rules: { silentRead: boolean; replyAtAll: boolean; allowDm: boolean };
  statusLine: string;
}

export interface AiStat {
  key: string;
  label: string;
  value: string;
  note: string;
}

export interface AiTrackedPerson {
  userId: string;
  name: string;
  avatarUrl: string | null;
  scene: string;
  summary: string;
  keys: string[];
  lastActiveAt: number;
}

export interface AiOverview extends AiSettings {
  stats: AiStat[];
  rows: AiTrackedPerson[];
}

/**
 * 一条消息搜索结果：消息本身，外加它所属会话的标题与类型，
 * 前端不必再去会话列表里回查就能渲染，也能直接跳过去。
 */
export interface MessageSearchResult extends Message {
  conversationTitle: string;
  conversationType: ConversationType;
}

/** 一页消息搜索结果，按时间倒序。nextBefore 是下一页游标（本页最早那条的 id）。 */
export interface MessageSearchPage {
  query: string;
  results: MessageSearchResult[];
  hasMore: boolean;
  nextBefore: string | null;
}

export interface AiProfileDetail {
  profile: {
    userId: string;
    name: string;
    avatarUrl: string | null;
    scene: string;
    summary: string;
    note: string;
    habits: string[];
    keys: string[];
    lastActiveAt: number;
  };
  raw: { name: string; text: string; createdAt: number }[];
}
