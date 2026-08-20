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
}

export interface GroupMember extends User {
  roleInGroup: string;
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
