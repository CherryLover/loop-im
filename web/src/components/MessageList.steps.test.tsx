// Agent 执行过程（D15'）：过程平铺在气泡里——历史一进来就全可见（不用点开），
// 进行中的气泡随步子一步步长出来，尾部保留跳动的点；分割线下面才是最终结论。
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageList } from './MessageList';
import type { AgentStep, Message } from '../lib/types';

const aiReply = (progress: AgentStep[]): Message => ({
  id: 'm_ai',
  conversationId: 'c1',
  senderId: 'ai-codex',
  senderName: 'Codex',
  senderAvatarUrl: null,
  body: '画好了，请查收。',
  mentions: [],
  createdAt: 1_700_000_000_000,
  isAI: true,
  progress,
});

const steps: AgentStep[] = [
  { seq: 1, kind: 'text', content: '我先想想构图。', createdAt: 1 },
  { seq: 2, kind: 'tool', content: '执行命令：python3 gen.py', createdAt: 2 },
  { seq: 3, kind: 'text', content: '图片正在生成。', createdAt: 3 },
];

describe('历史里的过程气泡', () => {
  it('过程平铺直给：中间文字、工具行、分割线、最终结论全在一个气泡里，无需任何点击', () => {
    render(<MessageList messages={[aiReply(steps)]} meId="u_me" showSenderName typing={false} />);

    expect(screen.getByText('我先想想构图。')).toBeInTheDocument();
    expect(screen.getByText('执行命令：python3 gen.py')).toBeInTheDocument();
    expect(screen.getByText('图片正在生成。')).toBeInTheDocument();
    expect(screen.getByText('画好了，请查收。')).toBeInTheDocument();
    expect(screen.getByRole('separator')).toBeInTheDocument();
    // 顺序：过程在分割线上面，结论在下面
    const bubble = document.querySelector('.bubble--flow')!;
    const order = Array.from(bubble.children).map((el) => el.className.split(' ')[0]);
    expect(order.at(-1)).toBe('md');
    expect(order).toContain('flow__divider');
    expect(order.indexOf('flow__divider')).toBe(order.length - 2);
    // 不再有「点开才看」的入口
    expect(screen.queryByRole('button', { name: /执行过程/ })).not.toBeInTheDocument();
  });

  it('没有过程的 AI 回复还是普通气泡：没有分割线、不套流式布局', () => {
    render(<MessageList messages={[aiReply([])]} meId="u_me" showSenderName typing={false} />);
    expect(screen.getByText('画好了，请查收。')).toBeInTheDocument();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect(document.querySelector('.bubble--flow')).toBeNull();
  });
});

describe('进行中的气泡', () => {
  it('步子累积着往下排（文字成段、工具带扳手行），尾部保留跳动的点；没步子的 Agent 是纯打点气泡', () => {
    render(
      <MessageList
        messages={[]}
        meId="u_me"
        showSenderName
        typing
        typingAgents={[
          { id: 'ai-codex', name: 'Codex' },
          { id: 'ai-grok', name: 'Grok-Build' },
        ]}
        typingSteps={{
          'ai-codex': [
            { seq: 1, kind: 'text', content: '我来画一下。', createdAt: 8 },
            { seq: 2, kind: 'tool', content: '执行命令：ls', createdAt: 9 },
          ],
        }}
      />,
    );
    // Codex 的气泡里过程已经长出来了，且点还在跳（还没写完）
    const codexBubble = screen.getByRole('status', { name: 'Codex 正在处理' });
    expect(codexBubble).toHaveTextContent('我来画一下。');
    expect(codexBubble).toHaveTextContent('执行命令：ls');
    expect(codexBubble.querySelector('.typing')).not.toBeNull();
    // 进行中不画分割线——线是「收工」的标志
    expect(codexBubble.querySelector('.flow__divider')).toBeNull();

    // Grok 还没动静：纯打点
    const grokBubble = screen.getByRole('status', { name: 'Grok-Build 正在处理' });
    expect(grokBubble.querySelector('.flow__say')).toBeNull();
    expect(grokBubble.querySelector('.typing')).not.toBeNull();
  });
});
