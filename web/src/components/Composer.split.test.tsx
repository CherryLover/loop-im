// 文字和媒体各占一个气泡：产品上不做图文混排，一条消息一个气泡，所以输入框里同时有
// 正文和附件时要**发两条**（文字在前、媒体在后），而不是像以前那样拼成一段正文。
//
// 这带来一个以前不存在的中间态：第一条成了、第二条没成。本文件的重点就是它 ——
// 已经发出去的那部分绝不能退回输入框，否则用户会以为没发出去，重试一次就发重了。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Composer } from './Composer';
import type { Conversation, ReplyTarget } from '../lib/types';

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

const fetchMock = vi.fn();

/** 这次上传返回什么。 */
const uploadReturns = (body: Record<string, unknown>) => {
  fetchMock.mockResolvedValue({ ok: true, status: 201, text: async () => JSON.stringify(body) });
};

const PNG = { url: '/uploads/9f3a.png', filename: 'shot.png', kind: 'image', storage: 'local' };
const PNG_EMBED = '![shot.png](/uploads/9f3a.png)';

beforeEach(() => {
  vi.restoreAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

/** 带会话切换和「回复」按钮的最小外壳，和 Composer.reply.test.tsx 是同一个路子。 */
function Harness({ onSend }: { onSend: (body: string, replyTo?: string | null) => void | Promise<void> }) {
  const [active, setActive] = useState(groupA);
  const [request, setRequest] = useState<ReplyTarget | null>(null);
  return (
    <div>
      <button type="button" onClick={() => setActive(groupA)}>切到A</button>
      <button type="button" onClick={() => setActive(groupB)}>切到B</button>
      <button type="button" onClick={() => setRequest({ ...FROM_CHEN })}>回复陈子航</button>
      <Composer conversation={active} meId="u_lin" onSend={onSend} replyRequest={request} />
    </div>
  );
}

const setup = (onSend: (body: string, replyTo?: string | null) => void | Promise<void>) => {
  const { container } = render(<Harness onSend={onSend} />);
  const input = () => screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
  return {
    container,
    input,
    type: (value: string) => fireEvent.change(input(), { target: { value } }),
    click: (name: string) => fireEvent.click(screen.getByRole('button', { name })),
    send: () => fireEvent.click(screen.getByRole('button', { name: '发送' })),
    pickImage: async () => {
      uploadReturns(PNG);
      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(['fake'], 'shot.png', { type: 'image/png' })] },
      });
      await screen.findByText('已上传，将作为图片附件发送');
    },
  };
};

/** 让在途的 Promise 全部落地。 */
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

describe('文字与媒体各占一个气泡', () => {
  it('同时有正文和附件时发两条，文字在前、媒体在后', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const t = setup(onSend);
    await t.pickImage();
    t.type('这是今天的构建结果');

    t.send();
    await settle();

    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[0][0]).toBe('这是今天的构建结果');
    expect(onSend.mock.calls[1][0]).toBe(PNG_EMBED);
    // 拼在一起的那种老写法不该再出现。
    expect(onSend.mock.calls[0][0]).not.toContain('/uploads/');
  });

  it('只有文字时仍然只发一条', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const t = setup(onSend);
    t.type('周五发版');

    t.send();
    await settle();

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('周五发版');
  });

  it('只有附件时仍然只发一条', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const t = setup(onSend);
    await t.pickImage();

    t.send();
    await settle();

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(PNG_EMBED);
  });

  it('两条发完，输入框和附件条都是空的', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const t = setup(onSend);
    await t.pickImage();
    t.type('看图');

    t.send();
    await settle();

    expect(t.input().value).toBe('');
    expect(t.container.querySelector('.attach')).toBeNull();
  });
});

describe('引用只挂在其中一条上', () => {
  it('有文字时，引用挂文字那条，媒体那条不带', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const t = setup(onSend);
    await t.pickImage();
    t.click('回复陈子航');
    t.type('见图');

    t.send();
    await settle();

    expect(onSend.mock.calls[0]).toEqual(['见图', 'm_1']);
    // 第二条不传第二个参数，调用形态和「不引用」时完全一样。
    expect(onSend.mock.calls[1]).toEqual([PNG_EMBED]);
  });

  it('只有附件时，引用挂在附件那条上', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const t = setup(onSend);
    await t.pickImage();
    t.click('回复陈子航');

    t.send();
    await settle();

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]).toEqual([PNG_EMBED, 'm_1']);
  });
});

describe('两条里只有一条失败', () => {
  it('文字成了、媒体没成：只有附件退回来，已经发出去的文字不许回到输入框', async () => {
    const onSend = vi.fn()
      .mockResolvedValueOnce(undefined)                        // 文字这条成功
      .mockRejectedValueOnce(new Error('服务暂时不可用'));      // 媒体这条失败
    const t = setup(onSend);
    await t.pickImage();
    t.type('构建结果如下');

    t.send();
    await settle();

    expect(onSend).toHaveBeenCalledTimes(2);
    // 关键断言：输入框仍然是空的。文字那条真的已经在对话里了，退回去会让用户发第二遍。
    expect(t.input().value).toBe('');
    // 失败的那一半回到附件条上，可以直接重发。
    expect(screen.getByText('shot.png')).toBeInTheDocument();
    expect(screen.getByText('已上传，将作为图片附件发送')).toBeInTheDocument();
    // 重发只补发媒体那一条。
    onSend.mockResolvedValue(undefined);
    t.send();
    await settle();
    expect(onSend).toHaveBeenCalledTimes(3);
    expect(onSend.mock.calls[2]).toEqual([PNG_EMBED]);
  });

  it('文字没成：整组退回，媒体那条根本不发（顺序不能颠倒）', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('服务暂时不可用'));
    const t = setup(onSend);
    await t.pickImage();
    t.type('构建结果如下');

    t.send();
    await settle();

    expect(onSend).toHaveBeenCalledTimes(1);                   // 媒体那条没有发出去
    expect(t.input().value).toBe('构建结果如下');
    expect(screen.getByText('shot.png')).toBeInTheDocument();
  });

  it('文字没成时，引用态也一起退回来', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('服务暂时不可用'));
    const t = setup(onSend);
    await t.pickImage();
    t.click('回复陈子航');
    t.type('见图');

    t.send();
    await settle();

    expect(screen.getByText('回复 陈子航')).toBeInTheDocument();
  });

  it('引用挂在文字那条、只有媒体失败时，引用不退回（那条已经带着引用发出去了）', async () => {
    const onSend = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('服务暂时不可用'));
    const t = setup(onSend);
    await t.pickImage();
    t.click('回复陈子航');
    t.type('见图');

    t.send();
    await settle();

    expect(screen.queryByText('回复 陈子航')).not.toBeInTheDocument();
    expect(screen.getByText('shot.png')).toBeInTheDocument();
  });

  it('只有附件、引用挂在它身上：失败时附件和引用一起退回', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('服务暂时不可用'));
    const t = setup(onSend);
    await t.pickImage();
    t.click('回复陈子航');

    t.send();
    await settle();

    expect(screen.getByText('shot.png')).toBeInTheDocument();
    expect(screen.getByText('回复 陈子航')).toBeInTheDocument();
  });

  it('等待期间用户又打了新字，还原不会把它覆盖掉', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('服务暂时不可用'));
    const t = setup(onSend);
    t.type('第一次的内容');

    t.send();
    t.type('等待时打的新内容');
    await settle();

    expect(t.input().value).toBe('等待时打的新内容');
  });
});

describe('发送期间切走会话', () => {
  it('两条都失败时，整组还给发送时的那个会话，不落到当前会话上', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('服务暂时不可用'));
    const t = setup(onSend);
    await t.pickImage();
    t.type('A 群的内容');

    t.send();
    t.click('切到B');                                          // 发送在途，人已经切走
    await settle();

    // B 群这边什么都不该多出来。
    expect(t.input().value).toBe('');
    expect(screen.queryByText('shot.png')).not.toBeInTheDocument();

    // 切回 A，文字和附件原样还在。
    t.click('切到A');
    expect(t.input().value).toBe('A 群的内容');
    expect(screen.getByText('shot.png')).toBeInTheDocument();
  });

  it('只有媒体失败时，退回来的附件也认准发送时的那个会话', async () => {
    const onSend = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('服务暂时不可用'));
    const t = setup(onSend);
    await t.pickImage();
    t.type('A 群的内容');

    t.send();
    t.click('切到B');
    await settle();

    expect(screen.queryByText('shot.png')).not.toBeInTheDocument();
    expect(t.input().value).toBe('');

    t.click('切到A');
    expect(screen.getByText('shot.png')).toBeInTheDocument();
    // 文字那条在 A 群已经发出去了，切回来输入框仍然是空的。
    expect(t.input().value).toBe('');
  });
});
