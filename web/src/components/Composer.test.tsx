import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from './Composer';
import type { Conversation } from '../lib/types';

const member = (id: string, name: string, isAI = false) => ({
  id, name, email: `${id}@loop.dev`, dept: '产品',
  role: (isAI ? 'ai' : 'member') as 'ai' | 'member',
  avatarUrl: null, isAI, online: true, roleInGroup: '产品',
});

const group: Conversation = {
  id: 'c_release',
  type: 'group',
  title: '产品 · 发版协作',
  peerId: null,
  members: [member('u_lin', '林悦'), member('u_chen', '陈子航'), member('u_zhou', '周明'), member('ai', 'Aria', true)],
  lastMessage: null,
};

const setup = (conversation: Conversation = group) => {
  const onSend = vi.fn();
  render(<Composer conversation={conversation} meId="u_lin" onSend={onSend} />);
  return { onSend, user: userEvent.setup(), input: screen.getByRole('textbox') };
};

describe('输入框', () => {
  it('提示文案说明支持 Markdown、粘贴图片和 @', () => {
    setup();
    expect(screen.getByPlaceholderText(/支持 Markdown、粘贴图片、@ 提及成员或 AI/)).toBeInTheDocument();
  });

  it('Enter 发送，Shift+Enter 换行', async () => {
    const { onSend, user, input } = setup();
    await user.type(input, '周五发版吗');
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('周五发版吗');

    await user.type(input, '第一行');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('空消息不会发出去', async () => {
    const { onSend, user, input } = setup();
    await user.type(input, '   ');
    await user.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });
});

describe('@ 提及气泡', () => {
  it('输入 @ 弹出成员列表，群聊里带 @全员，AI 标注必定回复', async () => {
    const { user, input } = setup();
    await user.type(input, '@');
    expect(screen.getByText('提及 · ↑↓ 选择，Enter 确认')).toBeInTheDocument();
    expect(screen.getByText('@全员')).toBeInTheDocument();
    expect(screen.getByText('Aria（AI 助手）')).toBeInTheDocument();
    expect(screen.getByText('必定回复')).toBeInTheDocument();
    expect(screen.queryByText('林悦')).not.toBeInTheDocument();   // 自己不在候选里
  });

  it('↑↓ 选择、Enter 确认，把名字写进输入框', async () => {
    const { user, input } = setup();
    await user.type(input, '@');
    await user.keyboard('{ArrowDown}{Enter}');                    // 全员 → Aria
    expect(input).toHaveValue('@Aria ');
    expect(screen.queryByText('提及 · ↑↓ 选择，Enter 确认')).not.toBeInTheDocument();
  });

  it('↑ 从第一项回卷到最后一项', async () => {
    const { user, input } = setup();
    await user.type(input, '@');
    await user.keyboard('{ArrowUp}{Enter}');
    expect(input).toHaveValue('@周明 ');
  });

  it('继续输入会过滤候选', async () => {
    const { user, input } = setup();
    await user.type(input, '@周');
    expect(screen.getByText('周明')).toBeInTheDocument();
    expect(screen.queryByText('@全员')).not.toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(input).toHaveValue('@周明 ');
  });

  it('Esc 关掉气泡，Enter 恢复为发送', async () => {
    const { onSend, user, input } = setup();
    await user.type(input, '@');
    await user.keyboard('{Escape}');
    expect(screen.queryByText('提及 · ↑↓ 选择，Enter 确认')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('@');
  });

  it('AI 私聊里没有 @全员', async () => {
    const { user, input } = setup({
      ...group, id: 'c_ai', type: 'ai', title: 'Aria',
      members: [member('u_lin', '林悦'), member('ai', 'Aria', true)],
    });
    await user.type(input, '@');
    expect(screen.queryByText('@全员')).not.toBeInTheDocument();
    expect(screen.getByText('Aria（AI 助手）')).toBeInTheDocument();
  });
});
