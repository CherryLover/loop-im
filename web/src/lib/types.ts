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
}

export type ConversationType = 'group' | 'dm' | 'ai';

export interface Conversation {
  id: string;
  type: ConversationType;
  title: string;
  peerId: string | null;
  members: GroupMember[];
  lastMessage: { preview: string; createdAt: number } | null;
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
