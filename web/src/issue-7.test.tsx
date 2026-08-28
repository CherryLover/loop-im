import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageList } from './components/MessageList';
import { clock } from './lib/format';
import type { Message } from './lib/types';

// jsdom 没有 scrollIntoView，消息列表挂载时会用到。
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

// issue #7：消息发出去只代表送达服务端，不能据此显示「已读」。
const message = (over: Partial<Message> = {}): Message => ({
  id: 'm_1',
  conversationId: 'c_release',
  senderId: 'u_lin',
  senderName: '林悦',
  senderAvatarUrl: null,
  body: '周五发版吗',
  mentions: [],
  createdAt: Date.now(),
  isAI: false,
  ...over,
});

const list = (messages: Message[]) =>
  render(
    <MessageList messages={messages} meId="u_lin" showSenderName typing={false} />,
  );

describe('自己发出的消息状态', () => {
  it('发送成功后显示「已发送」而不是「已读」', () => {
    const mine = message({ createdAt: new Date(2026, 0, 5, 21, 53).getTime() });
    list([mine]);
    expect(screen.queryByText(/已读/)).not.toBeInTheDocument();
    expect(screen.getByText(`${clock(mine.createdAt)} · 已发送`)).toBeInTheDocument();
  });

  it('在途消息显示「发送中…」', () => {
    list([message({ id: 'tmp_1', pending: true })]);
    expect(screen.getByText('发送中…')).toBeInTheDocument();
    expect(screen.queryByText(/已读|已发送/)).not.toBeInTheDocument();
  });

  it('私聊、群聊、AI 会话都不会把送达当成已读', () => {
    list([
      message({ id: 'm_dm', body: '在吗' }),
      message({ id: 'm_group', body: '@全员 周会挪到周四' }),
      message({ id: 'm_ai', body: '@Aria 帮我总结一下' }),
    ]);
    expect(screen.queryAllByText(/已读/)).toHaveLength(0);
    expect(screen.getAllByText(/· 已发送$/)).toHaveLength(3);
  });

  it('别人发来的消息只显示时间，不带发送状态', () => {
    const other = message({ id: 'm_2', senderId: 'u_chen', senderName: '陈子航', body: '应该可以' });
    list([other]);
    expect(screen.getByText(clock(other.createdAt))).toBeInTheDocument();
    expect(screen.queryByText(/已读|已发送/)).not.toBeInTheDocument();
  });

  it('AI 的历史消息只显示时间，同样不带发送状态', () => {
    // Aria 退役后不再有「由 … 生成」的供应商标注，历史 AI 消息按普通对端消息展示。
    const ai = message({ id: 'm_ai_reply', senderId: 'ai', senderName: 'Aria', isAI: true, body: '已收到' });
    list([ai]);
    expect(screen.getByText(clock(ai.createdAt))).toBeInTheDocument();
    expect(screen.queryByText(/已读|已发送|由 .+ 生成/)).not.toBeInTheDocument();
  });
});
