// 气泡上的「回复」入口、气泡里的引用块，以及点引用块跳到原消息。
// 被引用的消息可能已经不在了（被删掉、或者根本不属于这个会话）——
// 服务端把这种情况标成 available: false，界面必须明确地说「消息已不可用」而不是留白。
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageList } from './MessageList';
import type { Message } from '../lib/types';

const AT = 1_700_000_000_000;

const msg = (id: string, over: Partial<Message> = {}): Message => ({
  id,
  conversationId: 'c1',
  senderId: 'u_chen',
  senderName: '陈子航',
  senderAvatarUrl: null,
  body: `内容 ${id}`,
  mentions: [],
  createdAt: AT,
  isAI: false,
  ...over,
});

const view = (messages: Message[], onReply?: (m: Message) => void) =>
  render(
    <MessageList
      messages={messages}
      meId="u_lin"
      showSenderName
      typing={false}
      onReply={onReply}
    />,
  );

describe('气泡上的回复入口', () => {
  it('点「回复」把整条消息交给上层', async () => {
    const onReply = vi.fn();
    const target = msg('m_1', { body: '联调排期改到下周二' });
    view([target], onReply);

    await userEvent.click(screen.getByRole('button', { name: '引用回复 陈子航 的消息' }));
    expect(onReply).toHaveBeenCalledWith(target);
  });

  it('自己发的消息同样可以被引用', async () => {
    const onReply = vi.fn();
    const mine = msg('m_2', { senderId: 'u_lin', senderName: '林悦' });
    view([mine], onReply);

    await userEvent.click(screen.getByRole('button', { name: '引用回复 林悦 的消息' }));
    expect(onReply).toHaveBeenCalledWith(mine);
  });

  it('不传 onReply 时不显示回复入口（比如只读场景）', () => {
    view([msg('m_1')]);
    expect(screen.queryByRole('button', { name: /引用回复/ })).not.toBeInTheDocument();
  });

  it('系统提示上没有回复入口', () => {
    view([msg('m_sys', { kind: 'system', body: '林悦 邀请 陈子航 加入了群聊' })], vi.fn());
    expect(screen.queryByRole('button', { name: /引用回复/ })).not.toBeInTheDocument();
  });
});

describe('气泡里的引用块', () => {
  it('显示被引用消息的发送者和摘要', () => {
    view([
      msg('m_1', { body: '联调排期改到下周二' }),
      msg('m_2', {
        senderId: 'u_lin', senderName: '林悦', body: '收到',
        replyTo: 'm_1', quote: { senderName: '陈子航', preview: '联调排期改到下周二', available: true },
      }),
    ]);

    const quote = screen.getByRole('button', { name: /联调排期改到下周二/ });
    expect(quote).toHaveTextContent('陈子航');
    expect(quote).toHaveTextContent('联调排期改到下周二');
  });

  it('没有引用的消息不渲染引用块', () => {
    view([msg('m_1')]);
    expect(document.querySelector('.quote')).toBeNull();
  });

  it('原消息不可用时显示「消息已不可用」，且点不动', async () => {
    view([
      msg('m_2', {
        body: '收到', replyTo: 'm_gone',
        quote: { senderName: '', preview: '消息已不可用', available: false },
      }),
    ]);

    const quote = screen.getByText('消息已不可用').closest('button') as HTMLButtonElement;
    expect(quote).toBeDisabled();
    expect(quote.className).toContain('quote--gone');

    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await userEvent.click(quote, { pointerEventsCheck: 0 });
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe('点引用块跳到原消息', () => {
  it('原消息在当前页里时滚过去并高亮', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;

    view([
      msg('m_1', { body: '联调排期改到下周二' }),
      msg('m_2', {
        senderId: 'u_lin', senderName: '林悦', body: '收到',
        replyTo: 'm_1', quote: { senderName: '陈子航', preview: '联调排期改到下周二', available: true },
      }),
    ]);
    scroll.mockClear();                          // 首次渲染自己会滚到底，先清掉

    await userEvent.click(screen.getByRole('button', { name: /联调排期改到下周二/ }));

    expect(scroll).toHaveBeenCalledWith({ block: 'center' });
    expect(document.querySelector('[data-mid="m_1"]')?.className).toContain('msg--flash');
  });

  it('原消息还没翻页出来时按兵不动，不会滚到别的地方去', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;

    view([
      msg('m_2', {
        body: '收到', replyTo: 'm_很久以前的一条',
        quote: { senderName: '陈子航', preview: '很久以前说的话', available: true },
      }),
    ]);
    scroll.mockClear();

    await userEvent.click(screen.getByRole('button', { name: /很久以前说的话/ }));
    expect(scroll).not.toHaveBeenCalled();
    expect(document.querySelector('.msg--flash')).toBeNull();
  });
});
