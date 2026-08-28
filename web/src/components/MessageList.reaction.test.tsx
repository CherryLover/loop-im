// 气泡下方的表情回应：已有的一排（表情 + 计数，指上去看到都有谁）、
// 点一下切换自己那一个、以及末尾那个选表情的入口。
// 表情列表是写死的一小组（web/src/lib/reactions.ts），没有表情选择器依赖。
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageList } from './MessageList';
import { REACTION_EMOJIS } from '../lib/reactions';
import type { Message, MessageReaction } from '../lib/types';

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

const reaction = (over: Partial<MessageReaction> = {}): MessageReaction => ({
  emoji: '👍',
  count: 1,
  users: [{ id: 'u_zhou', name: '周明' }],
  mine: false,
  ...over,
});

const view = (messages: Message[], onReact?: (m: Message, emoji: string) => void) =>
  render(
    <MessageList
      messages={messages}
      meId="u_lin"
      showSenderName
      typing={false}
      onReact={onReact}
    />,
  );

describe('已有的回应', () => {
  it('显示表情和计数，指上去能看到都有谁', () => {
    view([msg('m_1', {
      reactions: [reaction({ count: 2, users: [{ id: 'u_zhou', name: '周明' }, { id: 'u_wu', name: '吴桐' }] })],
    })]);

    const chip = screen.getByRole('button', { name: /👍 2 人/ });
    expect(chip).toHaveTextContent('👍');
    expect(chip).toHaveTextContent('2');
    expect(chip).toHaveAttribute('title', '周明、吴桐 点了 👍');
  });

  it('自己点过的那个高亮，并且标成 aria-pressed', () => {
    view([msg('m_1', { reactions: [reaction({ mine: true }), reaction({ emoji: '🎉' })] })]);

    const mine = screen.getByRole('button', { name: /👍 1 人，包括我/ });
    expect(mine.className).toContain('reaction--mine');
    expect(mine).toHaveAttribute('aria-pressed', 'true');

    const others = screen.getByRole('button', { name: '🎉 1 人' });
    expect(others.className).not.toContain('reaction--mine');
    expect(others).toHaveAttribute('aria-pressed', 'false');
  });

  it('点已有的回应就是切换自己那一个', async () => {
    const onReact = vi.fn();
    const target = msg('m_1', { reactions: [reaction({ mine: true })] });
    view([target], onReact);

    await userEvent.click(screen.getByRole('button', { name: /👍/ }));
    expect(onReact).toHaveBeenCalledWith(target, '👍');
  });

  it('自己发的消息同样能看到回应', () => {
    view([msg('m_1', { senderId: 'u_lin', senderName: '林悦', reactions: [reaction({ count: 3 })] })]);
    expect(screen.getByRole('button', { name: /👍 3 人/ })).toBeInTheDocument();
  });

  it('没有回应也没有 onReact 时，气泡下方什么都不多出来', () => {
    view([msg('m_1')]);
    expect(document.querySelector('.reactions')).toBeNull();
  });

  it('只读场景（不传 onReact）仍然显示已有回应，但点不动、也没有添加入口', () => {
    view([msg('m_1', { reactions: [reaction()] })]);
    expect(screen.getByRole('button', { name: /👍 1 人/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '添加表情回应' })).not.toBeInTheDocument();
  });
});

describe('选表情的入口', () => {
  it('点开之后给出固定的一组表情，选一个就回调并收起面板', async () => {
    const onReact = vi.fn();
    const target = msg('m_1');
    view([target], onReact);

    await userEvent.click(screen.getByRole('button', { name: '添加表情回应' }));
    const menu = screen.getByRole('menu');
    expect(screen.getAllByRole('menuitem')).toHaveLength(REACTION_EMOJIS.length);
    expect(menu).toHaveTextContent(REACTION_EMOJIS.join(''));

    await userEvent.click(screen.getByRole('menuitem', { name: '用 🎉 回应' }));
    expect(onReact).toHaveBeenCalledWith(target, '🎉');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('再点一次入口就收起来', async () => {
    view([msg('m_1')], vi.fn());
    const entry = screen.getByRole('button', { name: '添加表情回应' });

    await userEvent.click(entry);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(entry);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Esc 关掉面板', async () => {
    view([msg('m_1')], vi.fn());
    await userEvent.click(screen.getByRole('button', { name: '添加表情回应' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('同一时刻只开一个面板：在另一条上点开，前一条的就关了', async () => {
    view([msg('m_1'), msg('m_2')], vi.fn());
    const entries = screen.getAllByRole('button', { name: '添加表情回应' });

    await userEvent.click(entries[0]);
    await userEvent.click(entries[1]);
    expect(screen.getAllByRole('menu')).toHaveLength(1);
  });

  it('系统提示上没有回应入口', () => {
    view([msg('m_sys', { kind: 'system', body: '林悦 邀请 陈子航 加入了群聊' })], vi.fn());
    expect(screen.queryByRole('button', { name: '添加表情回应' })).not.toBeInTheDocument();
  });

  it('还在发送中的气泡上不给回应入口（服务端还没有这条消息的 id）', () => {
    view([msg('tmp_1', { pending: true })], vi.fn());
    expect(screen.queryByRole('button', { name: '添加表情回应' })).not.toBeInTheDocument();
  });
});
