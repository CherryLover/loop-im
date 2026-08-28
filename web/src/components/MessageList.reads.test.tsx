// 已读回执：只依据对方真实上报的已读位置，不拿在线状态或送达去推断。
// 这条底线是 issue #7 定下的，扩展成真实已读后依然要守住。
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageList } from './MessageList';
import { clock } from '../lib/format';
import type { Message, ReadState } from '../lib/types';

const AT = 1_700_000_000_000;

const mine = (over: Partial<Message> = {}): Message => ({
  id: 'm_mine',
  conversationId: 'c1',
  senderId: 'u_lin',
  senderName: '林悦',
  senderAvatarUrl: null,
  body: '周五发版吗',
  mentions: [],
  createdAt: AT,
  isAI: false,
  ...over,
});

const view = (reads: ReadState[], showReaderCount = false, message = mine()) =>
  render(
    <MessageList
      messages={[message]}
      meId="u_lin"
      showSenderName
      typing={false}
      reads={reads}
      showReaderCount={showReaderCount}
    />,
  );

describe('自己消息的已读状态', () => {
  it('没人读过时只说「已发送」', () => {
    view([]);
    expect(screen.getByText(`${clock(AT)} · 已发送`)).toBeInTheDocument();
    expect(screen.queryByText(/已读/)).not.toBeInTheDocument();
  });

  it('对方的已读位置早于这条消息，仍然是「已发送」', () => {
    view([{ userId: 'u_chen', lastReadAt: AT - 1 }]);
    expect(screen.getByText(`${clock(AT)} · 已发送`)).toBeInTheDocument();
  });

  it('私聊里对方读到了就显示「已读」', () => {
    view([{ userId: 'u_chen', lastReadAt: AT }]);
    expect(screen.getByText(`${clock(AT)} · 已读`)).toBeInTheDocument();
  });

  it('群聊显示读过的人数', () => {
    view([
      { userId: 'u_chen', lastReadAt: AT + 5 },
      { userId: 'u_zhou', lastReadAt: AT + 9 },
      { userId: 'u_su', lastReadAt: AT - 1 },   // 还没读到这条
    ], true);
    expect(screen.getByText(`${clock(AT)} · 2 人已读`)).toBeInTheDocument();
  });

  it('在途消息显示「发送中…」，不受已读位置影响', () => {
    view([{ userId: 'u_chen', lastReadAt: AT + 1000 }], false, mine({ pending: true }));
    expect(screen.getByText('发送中…')).toBeInTheDocument();
    expect(screen.queryByText(/已读|已发送/)).not.toBeInTheDocument();
  });

  it('别人发来的消息不带发送状态', () => {
    render(
      <MessageList
        messages={[mine({ id: 'm_other', senderId: 'u_chen', senderName: '陈子航' })]}
        meId="u_lin"
        showSenderName
        typing={false}
        reads={[{ userId: 'u_chen', lastReadAt: AT + 1 }]}
      />,
    );
    expect(screen.queryByText(/已读|已发送|发送中/)).not.toBeInTheDocument();
    expect(screen.getByText(clock(AT))).toBeInTheDocument();
  });
});
