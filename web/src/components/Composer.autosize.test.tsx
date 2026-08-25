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
  members: [member('u_lin', '林悦'), member('u_chen', '陈子航'), member('ai', 'Aria', true)],
  lastMessage: null,
  unread: 0,
  createdBy: 'u_lin',
};

/**
 * jsdom 不做布局，scrollHeight 天生是 0，量不出真实高度。这里给 textarea 装一个
 * 按行数算高度的 scrollHeight（20px 行高 + 18px 上下内边距，和 styles.css 同一套
 * 数字），组件的 layoutEffect 读到的就是「内容有几行」的真实映射。
 * 测的是约定本身：**高度必须写成 scrollHeight，且内容减少时能缩回去** ——
 * 后者靠先把 height 打回 auto 再量，漏了那一步这个用例会红。
 */
const setup = () => {
  const onSend = vi.fn();
  render(<Composer conversation={group} meId="u_lin" onSend={onSend} />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  Object.defineProperty(input, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) { return this.value.split('\n').length * 20 + 18; },
  });
  return { onSend, user: userEvent.setup(), input };
};

describe('输入框高度自适应', () => {
  it('单行 38px 起步，每多一行长高 20px', async () => {
    const { user, input } = setup();
    await user.type(input, '第一行');
    expect(input.style.height).toBe('38px');

    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(input, '第二行');
    expect(input.style.height).toBe('58px');

    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(input, '第三行');
    expect(input.style.height).toBe('78px');
  });

  it('删掉多行内容后缩回单行高度', async () => {
    const { user, input } = setup();
    await user.type(input, '第一行');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(input, '第二行');
    expect(input.style.height).toBe('58px');

    await user.clear(input);
    await user.type(input, '只剩一行');
    expect(input.style.height).toBe('38px');
  });

  it('发送清空后回到单行高度', async () => {
    const { onSend, user, input } = setup();
    await user.type(input, '第一行');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(input, '第二行');
    expect(input.style.height).toBe('58px');

    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('第一行\n第二行');
    expect(input.style.height).toBe('38px');
  });

  it('量不出高度（scrollHeight 为 0）时不把框压没', async () => {
    // 不装 scrollHeight 桩，用 jsdom 原生的 0：组件必须跳过写入，留给 CSS 的
    // min-height 兜底，而不是把 0px 写上去。
    const onSend = vi.fn();
    render(<Composer conversation={{ ...group, id: 'c_raw' }} meId="u_lin" onSend={onSend} />);
    const input = screen.getAllByRole('textbox').at(-1) as HTMLTextAreaElement;
    await userEvent.setup().type(input, '一段话');
    expect(input.style.height).toBe('auto');
  });
});
