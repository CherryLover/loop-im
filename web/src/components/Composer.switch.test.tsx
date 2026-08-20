// 切会话时草稿/附件会串台：Composer 的 draft、attachment 是纯本地 state，
// 换会话既不清空也不隔离，在 A 群打了半句话切到 B 群，那半句话还在输入框里，
// 顺手一回车就发错群。修法不是 key={active.id}（那会把「切回来草稿还在」也砍掉），
// 而是按会话 id 各存一份草稿。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Composer } from './Composer';
import type { Conversation } from '../lib/types';

const upload = vi.fn(async (file: File) => ({ url: `/uploads/${file.name}`, filename: file.name, storage: 'local' }));

vi.mock('../lib/api', () => ({
  MAX_UPLOAD_MB: 8,
  api: { upload: (file: File) => upload(file) },
}));

const member = (id: string, name: string, isAI = false) => ({
  id, name, email: `${id}@loop.dev`, dept: '产品',
  role: (isAI ? 'ai' : 'member') as 'ai' | 'member',
  avatarUrl: null, isAI, online: true, roleInGroup: '产品',
});

const conv = (id: string, title: string): Conversation => ({
  id,
  type: 'group',
  title,
  peerId: null,
  members: [member('u_lin', '林悦'), member('u_chen', '陈子航'), member('ai', 'Aria', true)],
  lastMessage: null,
  unread: 0,
  createdBy: 'u_lin',
});

const groupA = conv('c_a', '产品 · 发版协作');
const groupB = conv('c_b', '客户 · 交付群');

function Harness({ onSend, mounted = true }: { onSend: (body: string) => void | Promise<void>; mounted?: boolean }) {
  const [active, setActive] = useState<Conversation | null>(groupA);
  return (
    <div>
      <button type="button" onClick={() => setActive(groupA)}>切到A</button>
      <button type="button" onClick={() => setActive(groupB)}>切到B</button>
      <button type="button" onClick={() => setActive(null)}>关掉会话</button>
      {mounted && active ? <Composer conversation={active} meId="u_lin" onSend={onSend} /> : null}
    </div>
  );
}

const setup = (onSend: (body: string) => void | Promise<void> = vi.fn()) => {
  const { container } = render(<Harness onSend={onSend} />);
  const user = userEvent.setup();
  return {
    user,
    onSend,
    container,
    input: () => screen.getByRole('textbox') as HTMLTextAreaElement,
    toA: () => user.click(screen.getByRole('button', { name: '切到A' })),
    toB: () => user.click(screen.getByRole('button', { name: '切到B' })),
    close: () => user.click(screen.getByRole('button', { name: '关掉会话' })),
  };
};

// 附件走隐藏的 file input，直接派发 change 事件（userEvent 不点 display:none 的元素）
const attachFile = async (container: HTMLElement, name: string) => {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['x'], name, { type: 'image/png' });
  await act(async () => {
    fireEvent.change(fileInput, { target: { files: [file] } });
  });
};

beforeEach(() => {
  upload.mockClear();
  URL.createObjectURL = vi.fn((f: Blob) => `blob:${(f as File).name}`);
  URL.revokeObjectURL = vi.fn();
});

describe('切换会话时的草稿隔离', () => {
  it('在 A 打字后切到 B，B 的输入框是空的', async () => {
    const { user, input, toB } = setup();

    await user.type(input(), '联调排期改到下周二');
    await toB();

    expect(input()).toHaveValue('');
  });

  it('切走再切回来，A 的草稿还在（不是一刀切清掉）', async () => {
    const { user, input, toA, toB } = setup();

    await user.type(input(), '联调排期改到下周二');
    await toB();
    await user.type(input(), 'B 群随便写点');
    await toA();

    expect(input()).toHaveValue('联调排期改到下周二');

    await toB();
    expect(input()).toHaveValue('B 群随便写点');   // B 自己的草稿也各归各的
  });

  it('切回来时不会误触发 @ 气泡', async () => {
    const { user, input, toA, toB } = setup();

    await user.type(input(), '找 @Aria');
    await user.keyboard('{Escape}');
    await toB();
    await toA();

    expect(input()).toHaveValue('找 @Aria');
    expect(screen.queryByText('提及 · ↑↓ 选择，Enter 确认')).not.toBeInTheDocument();
  });

  it('A 发送成功后草稿被清掉，切走再切回来还是空的', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { user, input, toA, toB } = setup(onSend);

    await user.type(input(), '周五发版');
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('周五发版');
    expect(input()).toHaveValue('');

    await toB();
    await toA();
    expect(input()).toHaveValue('');
  });

  it('发送失败时切走了，草稿还给原会话而不是当前会话', async () => {
    let reject: (e: Error) => void = () => {};
    const onSend = vi.fn().mockImplementation(() => new Promise((_, r) => { reject = r; }));
    const { user, input, toA, toB } = setup(onSend);

    await user.type(input(), '这条本来是发 A 群的');
    await user.keyboard('{Enter}');
    await toB();                                  // 请求还在飞的时候切到 B

    await act(async () => {
      reject(new Error('网络错误'));
      await Promise.resolve();
    });

    expect(input()).toHaveValue('');              // B 群不该冒出别人的草稿
    await toA();
    expect(input()).toHaveValue('这条本来是发 A 群的');
  });
});

describe('切换会话时的附件隔离', () => {
  it('A 的附件不会跟到 B，切回 A 还在', async () => {
    const { container, input, toA, toB } = setup();

    await attachFile(container, 'release.png');
    expect(screen.getByText('release.png')).toBeInTheDocument();
    expect(screen.getByText('已上传，将作为图片附件发送')).toBeInTheDocument();

    await toB();
    expect(screen.queryByText('release.png')).not.toBeInTheDocument();
    expect(input()).toHaveValue('');

    await attachFile(container, 'bug.png');       // B 传自己的图
    expect(screen.getByText('bug.png')).toBeInTheDocument();
    expect(screen.queryByText('release.png')).not.toBeInTheDocument();

    await toA();
    expect(screen.getByText('release.png')).toBeInTheDocument();
    expect(screen.queryByText('bug.png')).not.toBeInTheDocument();
  });

  it('带附件发送成功后 A 干净了，切回来也不会冒出旧附件', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { user, container, toA, toB } = setup(onSend);

    await attachFile(container, 'release.png');
    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(onSend).toHaveBeenCalledWith('![release.png](/uploads/release.png)');
    expect(screen.queryByText('release.png')).not.toBeInTheDocument();

    await toB();
    await toA();
    expect(screen.queryByText('release.png')).not.toBeInTheDocument();
  });

  it('上传还没回来就切走，结果落到原会话而不是当前会话', async () => {
    let finish: (r: { url: string; filename: string; storage: string }) => void = () => {};
    upload.mockImplementationOnce(() => new Promise((res) => { finish = res as typeof finish; }));
    const { container, toA, toB } = setup();

    await attachFile(container, 'slow.png');
    expect(screen.getByText('上传中…')).toBeInTheDocument();

    await toB();
    expect(screen.queryByText('slow.png')).not.toBeInTheDocument();

    await act(async () => {
      finish({ url: '/uploads/slow.png', filename: 'slow.png', storage: 'local' });
      await Promise.resolve();
    });
    expect(screen.queryByText('slow.png')).not.toBeInTheDocument();   // 没串到 B 群

    await toA();
    expect(screen.getByText('slow.png')).toBeInTheDocument();
    expect(screen.getByText('已上传，将作为图片附件发送')).toBeInTheDocument();
  });
});

describe('预览图 blob 的释放', () => {
  it('切走只是暂存，不释放预览图（切回来缩略图还得能显示）', async () => {
    const { container, toB } = setup();

    await attachFile(container, 'release.png');
    await toB();

    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('发送成功、手动移除、换图都会释放预览图', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { user, container } = setup(onSend);

    await attachFile(container, 'a.png');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a.png');

    await attachFile(container, 'b.png');
    await attachFile(container, 'c.png');                  // 换图，b 作废
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:b.png');

    await user.click(screen.getByRole('button', { name: '移除附件' }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:c.png');
  });

  it('组件卸载时，所有会话暂存的预览图一起释放', async () => {
    const { container, close, toB } = setup();

    await attachFile(container, 'a.png');
    await toB();
    await attachFile(container, 'b.png');
    await close();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a.png');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:b.png');
  });
});
