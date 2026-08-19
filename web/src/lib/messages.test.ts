import { describe, expect, it } from 'vitest';
import { mergeMessage } from './messages';
import type { Message } from './types';

const message = (over: Partial<Message>): Message => ({
  id: 'm1',
  conversationId: 'c1',
  senderId: 'u_lin',
  senderName: '林悦',
  senderAvatarUrl: null,
  body: '你好',
  mentions: [],
  createdAt: 1000,
  isAI: false,
  ...over,
});

describe('消息合并', () => {
  it('按发送时间排序，AI 回复不会插到自己的消息前面', () => {
    const mine = message({ id: 'm_mine', createdAt: 2000, body: '@Aria 看下风险' });
    const reply = message({ id: 'm_ai', senderId: 'ai', isAI: true, createdAt: 2100, body: '已收到提及' });
    const merged = mergeMessage([reply], mine);
    expect(merged.map((m) => m.id)).toEqual(['m_mine', 'm_ai']);
  });

  it('同一条消息从 HTTP 和 SSE 各来一次也只保留一条', () => {
    const confirmed = message({ id: 'm_1' });
    expect(mergeMessage([confirmed], confirmed)).toHaveLength(1);
  });

  it('确认后的消息会顶掉对应的乐观占位', () => {
    const optimistic = message({ id: 'tmp_1', body: '在写了', pending: true, createdAt: 5000 });
    const confirmed = message({ id: 'm_9', body: '在写了', createdAt: 3000 });
    const merged = mergeMessage([optimistic], confirmed);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('m_9');
  });

  it('别人的同文本消息不会误删我的待发消息', () => {
    const mine = message({ id: 'tmp_1', body: '收到', pending: true, createdAt: 5000 });
    const theirs = message({ id: 'm_2', senderId: 'u_chen', body: '收到', createdAt: 4000 });
    const merged = mergeMessage([mine], theirs);
    expect(merged.map((m) => m.id)).toEqual(['m_2', 'tmp_1']);
  });

  it('待发送的消息始终排在最后', () => {
    const pending = message({ id: 'tmp_2', body: '还在发', pending: true, createdAt: 100 });
    const confirmed = message({ id: 'm_3', createdAt: 9000 });
    expect(mergeMessage([pending], confirmed).map((m) => m.id)).toEqual(['m_3', 'tmp_2']);
  });
});
