// 输入法（IME）保护：中文输入法下打英文，按回车是「把字母原样上屏」，
// 这个回车属于输入法——绝不能拿去发送消息或选中 @ 候选（实测会带出多余空格、
// 在错误的位置替换文字）。组合期间的方向键同理，不该去挪 @ 候选的高亮。
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from './Composer';
import type { Conversation } from '../lib/types';

const member = (id: string, name: string, isAI = false) => ({
  id, name, email: `${id}@loop.dev`, dept: '产品',
  role: (isAI ? 'ai' : 'member') as 'ai' | 'member',
  avatarUrl: null, isAI, online: true, roleInGroup: '产品',
});

const group: Conversation = {
  id: 'c_ime',
  type: 'group',
  title: '输入法验证',
  peerId: null,
  members: [member('u_lin', '林悦'), member('ai-codex', 'Codex', true)],
  lastMessage: null,
  unread: 0,
  createdBy: 'u_lin',
};

const setup = () => {
  const onSend = vi.fn();
  render(<Composer conversation={group} meId="u_lin" onSend={onSend} />);
  return { onSend, user: userEvent.setup(), input: screen.getByRole('textbox') };
};

describe('输入法组合期间的按键', () => {
  it('组合中的回车不发送：那是「结束组合上屏」的回车；组合结束后的回车照常发送', async () => {
    const { onSend, user, input } = setup();
    await user.type(input, 'hello');
    // 输入法组合期间的回车：isComposing 为真
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    // 老 Safari 在组合收尾那一下只给 keyCode 229
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('@ 气泡开着时，组合中的回车不选候选（不会把拼音换成「@名字 」带出空格）', async () => {
    const { user, input } = setup();
    await user.type(input, '@');
    expect(screen.getByText('提及 · ↑↓ 选择，Enter 确认')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    // 草稿仍是原样的 @，没有被替换成任何「@某某 」
    expect(input).toHaveValue('@');

    // 组合结束后的回车才算确认候选
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((input as HTMLTextAreaElement).value).toMatch(/^@\S+ $/);
  });

  it('组合中的方向键不挪 @ 候选高亮（那是输入法在翻自己的候选）', async () => {
    const { user, input } = setup();
    await user.type(input, '@');
    const first = document.querySelector('.mention-row--on')!.textContent;
    fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true });
    expect(document.querySelector('.mention-row--on')!.textContent).toBe(first);
  });
});
