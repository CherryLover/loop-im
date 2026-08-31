// 「输入中」指示器：多个 Agent 并行时要分得清是谁在忙。
// typingAgents 有名单就一人一行（自己的头像 + 名字）；没有名单（老服务端）
// 就退回原来那行通用的「AI」指示器——两条路都要一直好使。
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageList } from './MessageList';
import type { Message } from '../lib/types';

const other: Message = {
  id: 'm_1',
  conversationId: 'c1',
  senderId: 'u_chen',
  senderName: '陈子航',
  senderAvatarUrl: null,
  // 正文里刻意不出现 Agent 的名字：下面按名字断言指示器行时，才不会误命中消息本身
  body: '两位帮忙看看这个问题',
  mentions: ['ai-claude', 'ai-codex'],
  createdAt: 1_700_000_000_000,
  isAI: false,
};

const view = (typing: boolean, typingAgents?: { id: string; name: string }[]) =>
  render(
    <MessageList
      messages={[other]}
      meId="u_lin"
      showSenderName
      typing={typing}
      typingAgents={typingAgents}
    />,
  );

describe('「输入中」指示器', () => {
  it('两个 Agent 在忙：各渲染一行，名字各自正确', () => {
    view(true, [
      { id: 'ai-claude', name: 'Claude-Code' },
      { id: 'ai-codex', name: 'Codex' },
    ]);
    // 一人一行三点动画，名字挂在各自那行的气泡上方（与 AI 消息行同一种写法）
    expect(document.querySelectorAll('.typing')).toHaveLength(2);
    expect(screen.getByText('Claude-Code')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
  });

  it('没有 typingAgents 时旧行为不变：一行通用「AI」指示器，不带名字', () => {
    view(true);
    expect(document.querySelectorAll('.typing')).toHaveLength(1);
    expect(screen.queryByText('Claude-Code')).not.toBeInTheDocument();
  });

  it('typingAgents 为空数组但 typing 为真：同样退回通用「AI」兜底', () => {
    // 服务端理论上不会发这种组合，但老事件经 AppShell 归一成空数组后就是这个形状
    view(true, []);
    expect(document.querySelectorAll('.typing')).toHaveLength(1);
  });

  it('typing 为假时什么指示器都没有', () => {
    view(false, []);
    expect(document.querySelectorAll('.typing')).toHaveLength(0);
  });
});
