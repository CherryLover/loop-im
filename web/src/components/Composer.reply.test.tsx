// 引用态（正在回复哪一条）和草稿、附件是同一类东西：属于某个会话，不属于组件。
// 所以它必须跟草稿走同一套「按会话暂存」的机制 —— 在 A 群选了引用切到 B 群，
// B 群的输入框上不能挂着 A 群的引用块；切回 A 又得原样还在。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Composer } from './Composer';
import type { Conversation, ReplyTarget } from '../lib/types';

vi.mock('../lib/api', () => ({
  MAX_UPLOAD_MB: 8,
  api: { upload: vi.fn() },
}));

const member = (id: string, name: string) => ({
  id, name, email: `${id}@loop.dev`, dept: '产品', role: 'member' as const,
  avatarUrl: null, isAI: false, online: true, roleInGroup: '产品',
});

const conv = (id: string, title: string): Conversation => ({
  id,
  type: 'group',
  title,
  peerId: null,
  members: [member('u_lin', '林悦'), member('u_chen', '陈子航')],
  lastMessage: null,
  unread: 0,
  createdBy: 'u_lin',
});

const groupA = conv('c_a', '产品 · 发版协作');
const groupB = conv('c_b', '客户 · 交付群');

const FROM_CHEN: ReplyTarget = { id: 'm_1', senderName: '陈子航', preview: '联调排期改到下周二' };
const FROM_LIN: ReplyTarget = { id: 'm_9', senderName: '林悦', preview: 'B 群这条' };

/**
 * 把 ChatPage 那一层缩到最小：点「回复」就给 Composer 一个**新的**引用请求对象，
 * 引用态本身由 Composer 按会话保管。
 */
function Harness({ onSend }: { onSend: (body: string, replyTo?: string | null) => void | Promise<void> }) {
  const [active, setActive] = useState(groupA);
  const [request, setRequest] = useState<ReplyTarget | null>(null);
  return (
    <div>
      <button type="button" onClick={() => setActive(groupA)}>切到A</button>
      <button type="button" onClick={() => setActive(groupB)}>切到B</button>
      <button type="button" onClick={() => setRequest({ ...FROM_CHEN })}>回复陈子航</button>
      <button type="button" onClick={() => setRequest({ ...FROM_LIN })}>回复林悦</button>
      <Composer conversation={active} meId="u_lin" onSend={onSend} replyRequest={request} />
    </div>
  );
}

const setup = (onSend: (body: string, replyTo?: string | null) => void | Promise<void> = vi.fn()) => {
  render(<Harness onSend={onSend} />);
  const user = userEvent.setup();
  const click = (name: string) => user.click(screen.getByRole('button', { name }));
  return {
    user,
    onSend,
    input: () => screen.getByRole('textbox') as HTMLTextAreaElement,
    toA: () => click('切到A'),
    toB: () => click('切到B'),
    replyToChen: () => click('回复陈子航'),
    replyToLin: () => click('回复林悦'),
    bar: () => screen.queryByText('回复 陈子航'),
  };
};

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

describe('引用态的显示与取消', () => {
  it('选了引用后，输入框上方显示回复的是谁、哪一句', async () => {
    const { replyToChen } = setup();
    await replyToChen();

    expect(screen.getByText('回复 陈子航')).toBeInTheDocument();
    expect(screen.getByText('联调排期改到下周二')).toBeInTheDocument();
  });

  it('点叉可以取消引用', async () => {
    const { user, replyToChen, bar } = setup();
    await replyToChen();

    await user.click(screen.getByRole('button', { name: '取消引用' }));
    expect(bar()).not.toBeInTheDocument();
  });

  it('输入框里按 Esc 也能取消引用', async () => {
    const { user, input, replyToChen, bar } = setup();
    await replyToChen();

    await user.click(input());
    await user.keyboard('{Escape}');
    expect(bar()).not.toBeInTheDocument();
  });

  it('取消之后再点同一条消息的「回复」，引用态能重新挂上', async () => {
    const { user, replyToChen, bar } = setup();
    await replyToChen();
    await user.click(screen.getByRole('button', { name: '取消引用' }));
    await replyToChen();

    expect(bar()).toBeInTheDocument();
  });
});

describe('引用态按会话各存一份', () => {
  it('A 群选了引用 → 切到 B：B 没有引用 → 切回 A：引用还在', async () => {
    const { replyToChen, toA, toB, bar } = setup();

    await replyToChen();
    expect(bar()).toBeInTheDocument();

    await toB();
    expect(bar()).not.toBeInTheDocument();     // B 群不该挂着 A 群的引用

    await toA();
    expect(bar()).toBeInTheDocument();
    expect(screen.getByText('联调排期改到下周二')).toBeInTheDocument();
  });

  it('两个会话各自的引用互不覆盖', async () => {
    const { replyToChen, replyToLin, toA, toB } = setup();

    await replyToChen();                        // A 群回复陈子航
    await toB();
    await replyToLin();                         // B 群回复林悦
    expect(screen.getByText('回复 林悦')).toBeInTheDocument();
    expect(screen.queryByText('回复 陈子航')).not.toBeInTheDocument();

    await toA();
    expect(screen.getByText('回复 陈子航')).toBeInTheDocument();
    expect(screen.queryByText('回复 林悦')).not.toBeInTheDocument();
  });

  it('在 A 取消掉引用后切走再切回来，不会被旧的引用请求复活', async () => {
    const { user, replyToChen, toA, toB, bar } = setup();

    await replyToChen();
    await user.click(screen.getByRole('button', { name: '取消引用' }));
    await toB();
    await toA();

    expect(bar()).not.toBeInTheDocument();
  });

  it('引用态和草稿一起暂存，互不干扰', async () => {
    const { user, input, replyToChen, toA, toB, bar } = setup();

    await user.type(input(), 'A 群的草稿');
    await replyToChen();
    await toB();

    expect(input()).toHaveValue('');
    expect(bar()).not.toBeInTheDocument();

    await toA();
    expect(input()).toHaveValue('A 群的草稿');
    expect(bar()).toBeInTheDocument();
  });
});

describe('带引用发送', () => {
  it('发送时把被引用消息的 id 一起交出去，发完引用块消失', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { user, input, replyToChen, bar } = setup(onSend);

    await replyToChen();
    await user.type(input(), '收到');
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalledWith('收到', 'm_1');
    expect(bar()).not.toBeInTheDocument();
    expect(input()).toHaveValue('');
  });

  it('没有引用时不传第二个参数，调用形态和以前一样', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { user, input } = setup(onSend);

    await user.type(input(), '普通一条');
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalledWith('普通一条');
  });

  it('发送成功后切走再切回来，引用不会又冒出来', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { user, input, replyToChen, toA, toB, bar } = setup(onSend);

    await replyToChen();
    await user.type(input(), '收到');
    await user.keyboard('{Enter}');
    await toB();
    await toA();

    expect(bar()).not.toBeInTheDocument();
  });

  it('发送失败时切走了，引用还给原会话而不是当前会话', async () => {
    let reject: (e: Error) => void = () => {};
    const onSend = vi.fn().mockImplementation(() => new Promise((_, r) => { reject = r; }));
    const { user, input, replyToChen, toA, toB, bar } = setup(onSend);

    await replyToChen();
    await user.type(input(), '这条本来是回 A 群的');
    await user.keyboard('{Enter}');
    await toB();                                // 请求还在飞的时候切到 B

    await act(async () => {
      reject(new Error('网络错误'));
      await Promise.resolve();
    });

    expect(bar()).not.toBeInTheDocument();      // B 群不该冒出别人的引用
    expect(input()).toHaveValue('');

    await toA();
    expect(bar()).toBeInTheDocument();          // 引用和草稿一起还回 A 群
    expect(input()).toHaveValue('这条本来是回 A 群的');
  });

  it('发送失败时若用户已经选了新的引用，不覆盖新的那个', async () => {
    let reject: (e: Error) => void = () => {};
    const onSend = vi.fn().mockImplementation(() => new Promise((_, r) => { reject = r; }));
    const { user, input, replyToChen, replyToLin } = setup(onSend);

    await replyToChen();
    await user.type(input(), '在途');
    await user.keyboard('{Enter}');
    await replyToLin();                         // 等待期间改回复别人了

    await act(async () => {
      reject(new Error('网络错误'));
      await Promise.resolve();
    });

    expect(screen.getByText('回复 林悦')).toBeInTheDocument();
    expect(screen.queryByText('回复 陈子航')).not.toBeInTheDocument();
  });
});
