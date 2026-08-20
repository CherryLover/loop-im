// 会话列表排序：置顶的整体在前，两组内部仍按最后消息时间倒序。
// 这份口径要和服务端 routes/conversations.js 的 compareConversations 一模一样。
import { describe, expect, it } from 'vitest';
import { sortConversations } from './conversations';
import type { Conversation } from './types';

const convo = (id: string, at: number | null, over: Partial<Conversation> = {}): Conversation => ({
  id,
  type: 'group',
  title: id,
  peerId: null,
  createdBy: 'u_me',
  members: [],
  lastMessage: at === null ? null : { preview: '内容', createdAt: at },
  unread: 0,
  ...over,
});

const ids = (list: Conversation[]) => sortConversations(list).map((c) => c.id);

describe('会话列表排序', () => {
  it('没有置顶时就是按最后消息时间倒序', () => {
    expect(ids([convo('a', 100), convo('c', 300), convo('b', 200)])).toEqual(['c', 'b', 'a']);
  });

  it('置顶的排在最前面，哪怕它的消息更旧', () => {
    const list = [convo('新的', 300), convo('置顶的', 100, { pinned: true }), convo('中间的', 200)];
    expect(ids(list)).toEqual(['置顶的', '新的', '中间的']);
  });

  it('置顶组内部仍按最后消息时间倒序', () => {
    const list = [
      convo('置顶旧', 100, { pinned: true }),
      convo('普通', 400),
      convo('置顶新', 300, { pinned: true }),
    ];
    expect(ids(list)).toEqual(['置顶新', '置顶旧', '普通']);
  });

  it('非置顶组照旧，不因为有人置顶而变序', () => {
    const list = [
      convo('置顶', 500, { pinned: true }),
      convo('普通旧', 100),
      convo('普通新', 300),
      convo('普通中', 200),
    ];
    expect(ids(list)).toEqual(['置顶', '普通新', '普通中', '普通旧']);
  });

  it('还没有消息的会话排在本组最后，但置顶了照样在非置顶的前面', () => {
    const list = [convo('有消息', 100), convo('空置顶', null, { pinned: true }), convo('空的', null)];
    expect(ids(list)).toEqual(['空置顶', '有消息', '空的']);
  });

  it('免打扰不参与排序 —— 它只管怎么提醒，不管排在哪', () => {
    const list = [convo('a', 100, { muted: true }), convo('b', 200), convo('c', 300, { muted: true })];
    expect(ids(list)).toEqual(['c', 'b', 'a']);
  });

  it('不改动传进来的数组（列表是 React 状态，就地排序会漏掉重渲染）', () => {
    const list = [convo('a', 100), convo('b', 200)];
    const sorted = sortConversations(list);
    expect(list.map((c) => c.id)).toEqual(['a', 'b']);
    expect(sorted).not.toBe(list);
  });
});
