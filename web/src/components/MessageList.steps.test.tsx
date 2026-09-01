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
  it('过程平铺直给：中间文字、工具标记、分割线、最终结论全在一个气泡里，无需任何点击', () => {
    render(<MessageList messages={[aiReply(steps)]} meId="u_me" showSenderName typing={false} />);

    expect(screen.getByText('我先想想构图。')).toBeInTheDocument();
    expect(screen.getByText('图片正在生成。')).toBeInTheDocument();
    expect(screen.getByText('画好了，请查收。')).toBeInTheDocument();
    expect(screen.getByRole('separator')).toBeInTheDocument();
    // 工具步只留图标标记，不再写命令原文——明细收进悬停提示
    expect(screen.queryByText('执行命令：python3 gen.py')).not.toBeInTheDocument();
    const marker = document.querySelector('.flow__tool')!;
    expect(marker).toHaveAttribute('title', '执行命令：python3 gen.py');
    // 顺序：过程在分割线上面，结论在下面
    const bubble = document.querySelector('.bubble--flow')!;
    const order = Array.from(bubble.children).map((el) => el.className.split(' ')[0]);
    expect(order.at(-1)).toBe('md');
    expect(order).toContain('flow__divider');
    expect(order.indexOf('flow__divider')).toBe(order.length - 2);
    // 不再有「点开才看」的入口
    expect(screen.queryByRole('button', { name: /执行过程/ })).not.toBeInTheDocument();
  });

  it('连续的工具步合并成一个标记 ×N；单独一步不带 ×；文字步照常把它们隔开', () => {
    render(
      <MessageList
        messages={[aiReply([
          { seq: 1, kind: 'tool', content: '查环境', createdAt: 1 },
          { seq: 2, kind: 'tool', content: '写提示词文件', createdAt: 2 },
          { seq: 3, kind: 'tool', content: '执行命令：python3 gen.py', createdAt: 3 },
          { seq: 4, kind: 'text', content: '图好了，检查一下。', createdAt: 4 },
          { seq: 5, kind: 'tool', content: '读取文件', createdAt: 5 },
        ])]}
        meId="u_me" showSenderName typing={false}
      />,
    );
    const markers = document.querySelectorAll('.flow__tool');
    expect(markers).toHaveLength(2);
    expect(markers[0]).toHaveTextContent('×3');
    expect(markers[0]).toHaveAttribute('title', '查环境\n写提示词文件\n执行命令：python3 gen.py');
    expect(markers[1].querySelector('.flow__tool-n')).toBeNull();
    expect(markers[1]).toHaveAttribute('title', '读取文件');
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
    expect(codexBubble.querySelector('.flow__tool')).toHaveAttribute('title', '执行命令：ls');
    expect(codexBubble.querySelector('.typing')).not.toBeNull();
    // 进行中不画分割线——线是「收工」的标志
    expect(codexBubble.querySelector('.flow__divider')).toBeNull();

    // Grok 还没动静：纯打点
    const grokBubble = screen.getByRole('status', { name: 'Grok-Build 正在处理' });
    expect(grokBubble.querySelector('.flow__say')).toBeNull();
    expect(grokBubble.querySelector('.typing')).not.toBeNull();
  });
});
