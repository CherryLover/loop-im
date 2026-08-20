// 发送失败不能吞掉用户打的字：原来 submit() 一提交就清空 draft，
// 失败路径不还原，内容直接丢失，而且草稿为空会让「发送」按钮永久禁用。
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
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
  members: [member('u_lin', '林悦'), member('u_chen', '陈子航'), member('ai', 'Aria', true)],
  lastMessage: null,
  unread: 0,
  createdBy: 'u_lin',
};

const setup = (onSend: (body: string) => void | Promise<void>) => {
  render(<Composer conversation={group} meId="u_lin" onSend={onSend} />);
  return {
    user: userEvent.setup(),
    input: screen.getByRole('textbox') as HTMLTextAreaElement,
    sendButton: screen.getByRole('button', { name: '发送' }),
  };
};

describe('发送失败后的草稿', () => {
  it('发送失败时把内容还回输入框，「发送」按钮重新可用', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('服务暂时不可用'));
    const { user, input, sendButton } = setup(onSend);

    await user.type(input, '联调排期改到下周二');
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalledWith('联调排期改到下周二');
    expect(input).toHaveValue('联调排期改到下周二');
    expect(sendButton).toBeEnabled();
  });

  it('发送成功时照常清空', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { user, input, sendButton } = setup(onSend);

    await user.type(input, '周五发版');
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalledWith('周五发版');
    expect(input).toHaveValue('');
    expect(sendButton).toBeDisabled();
  });

  it('等待期间用户又打了新内容时，不覆盖新内容', async () => {
    let reject: (e: Error) => void = () => {};
    const onSend = vi.fn().mockImplementation(() => new Promise((_, r) => { reject = r; }));
    const { user, input } = setup(onSend);

    await user.type(input, '第一条');
    await user.keyboard('{Enter}');
    expect(input).toHaveValue('');            // 乐观清空

    await user.type(input, '我又想说点别的');   // 请求还在飞的时候继续打字
    await act(async () => {
      reject(new Error('网络错误'));
      await Promise.resolve();
    });

    expect(input).toHaveValue('我又想说点别的');
  });

  it('同步返回（不是 Promise）的 onSend 依然按成功处理', async () => {
    const onSend = vi.fn();                    // 返回 undefined
    const { user, input } = setup(onSend);

    await user.type(input, '同步实现也要能用');
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalledWith('同步实现也要能用');
    expect(input).toHaveValue('');
  });
});
