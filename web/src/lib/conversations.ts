import type { Conversation } from './types';

/**
 * 会话列表排序，与服务端 routes/conversations.js 里的 compareConversations 同一口径：
 * 置顶的整体排在前面，置顶组与非置顶组各自内部仍按最后消息时间倒序（没有消息的算 0，
 * 排在本组最后）。置顶只改分组，不改组内规则。
 *
 * 服务端返回的列表已经排好了，前端再留一份是为了「切换置顶时列表立刻就位」：
 * 不用等下一轮拉取回来，用户点完就能看到它跳到顶部。
 */
export const compareConversations = (a: Conversation, b: Conversation) =>
  Number(!!b.pinned) - Number(!!a.pinned)
  || (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0);

/** 排好序的新数组；不改动传进来的那个（列表是 React 状态，就地排序会漏掉重渲染）。 */
export const sortConversations = (list: Conversation[]) => [...list].sort(compareConversations);
