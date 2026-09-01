// Agent 执行过程（D15）：进行中「正在输入」行下的实时状态行，
// 和回复气泡下可展开的过程时间线（步子点开才拉、拉过缓存、可收起）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageList } from './MessageList';
import { api } from '../lib/api';
import type { AgentStep, Message } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: { messageSteps: vi.fn() },
  attachmentUrl: (u: string) => u,
}));
const mockApi = vi.mocked(api);

const aiReply = (progressCount: number): Message => ({
  id: 'm_ai',
  conversationId: 'c1',
  senderId: 'ai-codex',
  senderName: 'Codex',
  senderAvatarUrl: null,
  body: '画好了，请查收。',
  mentions: [],
  createdAt: 1_700_000_000_000,
  isAI: true,
  progressCount,
});

const steps: AgentStep[] = [
  { seq: 1, kind: 'text', content: '我先想想构图。', createdAt: 1 },
  { seq: 2, kind: 'tool', content: '执行命令：python3 gen.py', createdAt: 2 },
  { seq: 3, kind: 'text', content: '图片正在生成。', createdAt: 3 },
];

beforeEach(() => vi.clearAllMocks());

describe('回复气泡下的过程行', () => {
  it('点开拉步子并展开，再点收起；拉过一次不重复请求', async () => {
    mockApi.messageSteps.mockResolvedValue({ steps });
    render(<MessageList messages={[aiReply(3)]} meId="u_me" showSenderName typing={false} />);

    const toggle = screen.getByRole('button', { name: /执行过程（3 步）/ });
    expect(toggle).toHaveTextContent('执行过程 · 3 步');
    await userEvent.click(toggle);
    expect(mockApi.messageSteps).toHaveBeenCalledWith('c1', 'm_ai');
    expect(await screen.findByText('执行命令：python3 gen.py')).toBeInTheDocument();
    expect(screen.getByText('我先想想构图。')).toBeInTheDocument();

    await userEvent.click(toggle);                          // 收起
    expect(screen.queryByText('我先想想构图。')).not.toBeInTheDocument();
    await userEvent.click(toggle);                          // 再展开：用缓存，不再请求
    expect(await screen.findByText('我先想想构图。')).toBeInTheDocument();
    expect(mockApi.messageSteps).toHaveBeenCalledTimes(1);
  });

  it('progressCount 为 0 或缺省时不渲染过程行；接口失败就地提示', async () => {
    mockApi.messageSteps.mockRejectedValue(new Error('过程加载失败'));
    const { rerender } = render(
      <MessageList messages={[aiReply(0)]} meId="u_me" showSenderName typing={false} />,
    );
    expect(screen.queryByRole('button', { name: /执行过程/ })).not.toBeInTheDocument();

    rerender(<MessageList messages={[aiReply(2)]} meId="u_me" showSenderName typing={false} />);
    await userEvent.click(screen.getByRole('button', { name: /执行过程（2 步）/ }));
    await waitFor(() => expect(screen.getByText('过程加载失败')).toBeInTheDocument());
  });
});

describe('「正在输入」下的实时状态行', () => {
  it('有该 Agent 的最新一步就显示内容；没有的 Agent 只有三点', () => {
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
        typingSteps={{ 'ai-codex': { seq: 5, kind: 'tool', content: '执行命令：ls', createdAt: 9 } }}
      />,
    );
    expect(screen.getByText('执行命令：ls')).toBeInTheDocument();
    expect(document.querySelectorAll('.steps__live')).toHaveLength(1);
    expect(document.querySelectorAll('.typing')).toHaveLength(2);
  });
});
