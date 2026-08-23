// 非图片文件附件（配合 issue #22 的分流方案）：输入框现在能发 PDF / ZIP / DOCX 这类普通文件。
// 关键约定：
//   1. 图片拼成 Markdown 图片（会内联渲染），普通文件拼成普通链接（渲染成文件卡片，只能下载）；
//   2. 走哪一档以**服务端**返回的 kind 为准，不看浏览器给的 MIME；
//   3. 这一切不能破坏 #14 之后「每个会话各存一份草稿 + 附件」的机制。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Composer } from './Composer';
import type { Conversation } from '../lib/types';

const member = (id: string, name: string, isAI = false) => ({
  id, name, email: `${id}@loop.dev`, dept: '产品',
  role: (isAI ? 'ai' : 'member') as 'ai' | 'member',
  avatarUrl: null, isAI, online: true, roleInGroup: '产品',
});

const conversation = (id: string, title: string): Conversation => ({
  id,
  type: 'group',
  title,
  peerId: null,
  members: [member('u_lin', '林悦'), member('u_chen', '陈子航')],
  lastMessage: null,
  unread: 0,
  createdBy: 'u_lin',
});

const group = conversation('c_release', '产品 · 发版协作');
const other = conversation('c_backend', '后端 · 值班');

const fetchMock = vi.fn();

/** 让服务端的这次上传返回指定结果。 */
const serverReturns = (body: Record<string, unknown>) => {
  fetchMock.mockResolvedValue({ ok: true, status: 201, text: async () => JSON.stringify(body) });
};

beforeEach(() => {
  vi.restoreAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

const fileInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;

const pick = (container: HTMLElement, file: File) =>
  fireEvent.change(fileInput(container), { target: { files: [file] } });

const pdf = () => new File(['%PDF-1.4'], '发版清单.pdf', { type: 'application/pdf' });
const png = () => new File(['fake'], 'shot.png', { type: 'image/png' });
const mp4 = () => new File(['fake'], '晨会录屏.mp4', { type: 'video/mp4' });

describe('非图片文件附件', () => {
  it('选文件的入口不再限制成图片', () => {
    const { container } = render(<Composer conversation={group} meId="u_lin" onSend={vi.fn()} />);
    expect(fileInput(container).getAttribute('accept')).toBeNull();
  });

  it('PDF 上传成功后，附件条说明会作为文件附件发送，且不显示缩略图', async () => {
    serverReturns({ url: '/uploads/9f3a.bin', filename: '发版清单.pdf', kind: 'file', storage: 'local' });
    const { container } = render(<Composer conversation={group} meId="u_lin" onSend={vi.fn()} />);
    pick(container, pdf());

    expect(await screen.findByText('已上传，将作为文件附件发送')).toBeInTheDocument();
    expect(screen.getByText('发版清单.pdf')).toBeInTheDocument();
    expect(container.querySelector('.attach__thumb img')).toBeNull();
  });

  it('PDF 发出去的是普通链接，不是 Markdown 图片', async () => {
    serverReturns({ url: '/uploads/9f3a.bin', filename: '发版清单.pdf', kind: 'file', storage: 'local' });
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<Composer conversation={group} meId="u_lin" onSend={onSend} />);
    pick(container, pdf());
    await screen.findByText('已上传，将作为文件附件发送');

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await act(async () => { await Promise.resolve(); });

    expect(onSend).toHaveBeenCalledWith('[发版清单.pdf](/uploads/9f3a.bin)');
  });

  it('图片仍然按 Markdown 图片发送，并显示缩略图', async () => {
    serverReturns({ url: '/uploads/9f3a.png', filename: 'shot.png', kind: 'image', storage: 'local' });
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<Composer conversation={group} meId="u_lin" onSend={onSend} />);
    pick(container, png());
    await screen.findByText('已上传，将作为图片附件发送');
    expect(container.querySelector('.attach__thumb img')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await act(async () => { await Promise.resolve(); });

    expect(onSend).toHaveBeenCalledWith('![shot.png](/uploads/9f3a.png)');
  });

  it('以服务端的 kind 为准：浏览器说是图片、服务端判成文件时，按文件发', async () => {
    // 真实场景：用户选了一个扩展名/MIME 是图片、内容却不是图片的文件。
    // 服务端只按真实字节说话，前端不能拿 file.type 覆盖它。
    serverReturns({ url: '/uploads/9f3a.bin', filename: 'shot.png', kind: 'file', storage: 'local' });
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<Composer conversation={group} meId="u_lin" onSend={onSend} />);
    pick(container, png());
    await screen.findByText('已上传，将作为文件附件发送');

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await act(async () => { await Promise.resolve(); });

    expect(onSend).toHaveBeenCalledWith('[shot.png](/uploads/9f3a.bin)');
  });

  it('服务端拒绝（比如 HTML 谎报成图片）时，附件条显示服务端给的原因', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 400,
      text: async () => JSON.stringify({ error: '这不是有效的图片文件，只支持 PNG / JPEG / GIF / WebP' }),
    });
    const { container } = render(<Composer conversation={group} meId="u_lin" onSend={vi.fn()} />);
    pick(container, png());

    expect(await screen.findByText('这不是有效的图片文件，只支持 PNG / JPEG / GIF / WebP')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });

  it('显示名里的方括号会被去掉，不会撑破 Markdown 链接语法', async () => {
    serverReturns({ url: '/uploads/9f3a.bin', filename: '会议纪要[终版].docx', kind: 'file', storage: 'local' });
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<Composer conversation={group} meId="u_lin" onSend={onSend} />);
    pick(container, new File(['PK'], '会议纪要[终版].docx', { type: 'application/zip' }));
    await screen.findByText('已上传，将作为文件附件发送');

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await act(async () => { await Promise.resolve(); });

    expect(onSend).toHaveBeenCalledWith('[会议纪要终版.docx](/uploads/9f3a.bin)');
  });
});

describe('视频附件', () => {
  it('选文件的入口本来就不限类型，视频能选进来', () => {
    // 没有 accept 属性 = 什么都收，视频自然也在内（这条在 issue #22 就定下了）。
    const { container } = render(<Composer conversation={group} meId="u_lin" onSend={vi.fn()} />);
    expect(fileInput(container).getAttribute('accept')).toBeNull();
  });

  it('附件条给的是视频的说明，缩略图位置放胶片图标而不是 <img>', async () => {
    serverReturns({ url: '/uploads/9f3a.mp4', filename: '晨会录屏.mp4', kind: 'video', storage: 'local' });
    const { container } = render(<Composer conversation={group} meId="u_lin" onSend={vi.fn()} />);
    pick(container, mp4());

    expect(await screen.findByText('已上传，将作为视频发送，可在聊天里直接播放')).toBeInTheDocument();
    expect(screen.getByText('晨会录屏.mp4')).toBeInTheDocument();
    // 不给待发的视频做 <video> 预览：白解一遍码，附件条本来只是「选了什么」的提示。
    expect(container.querySelector('.attach__thumb img')).toBeNull();
    expect(container.querySelector('.attach__thumb video')).toBeNull();
  });

  it('视频拼成普通链接发出去，渲染成播放器由 md.ts 按后缀决定', async () => {
    serverReturns({ url: '/uploads/9f3a.mp4', filename: '晨会录屏.mp4', kind: 'video', storage: 'local' });
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<Composer conversation={group} meId="u_lin" onSend={onSend} />);
    pick(container, mp4());
    await screen.findByText('已上传，将作为视频发送，可在聊天里直接播放');

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await act(async () => { await Promise.resolve(); });

    // 用链接写法不用图片写法：视频本来就不是图片，而且在任何不认识视频的地方
    // （老客户端、纯文本摘要）都会降级成一条能点开的附件链接。
    expect(onSend).toHaveBeenCalledWith('[晨会录屏.mp4](/uploads/9f3a.mp4)');
  });

  it('以服务端的 kind 为准：浏览器说是视频、服务端判成文件时，按文件发', async () => {
    serverReturns({ url: '/uploads/9f3a.bin', filename: '晨会录屏.mp4', kind: 'file', storage: 'local' });
    const { container } = render(<Composer conversation={group} meId="u_lin" onSend={vi.fn()} />);
    pick(container, mp4());

    expect(await screen.findByText('已上传，将作为文件附件发送')).toBeInTheDocument();
  });
});

describe('文件附件与按会话分开的草稿', () => {
  it('切走再切回来，文件附件还在，且不会串到别的会话', async () => {
    serverReturns({ url: '/uploads/9f3a.bin', filename: '发版清单.pdf', kind: 'file', storage: 'local' });
    const { container, rerender } = render(<Composer conversation={group} meId="u_lin" onSend={vi.fn()} />);
    pick(container, pdf());
    await screen.findByText('已上传，将作为文件附件发送');

    rerender(<Composer conversation={other} meId="u_lin" onSend={vi.fn()} />);
    expect(screen.queryByText('发版清单.pdf')).not.toBeInTheDocument();

    rerender(<Composer conversation={group} meId="u_lin" onSend={vi.fn()} />);
    expect(screen.getByText('发版清单.pdf')).toBeInTheDocument();
    expect(screen.getByText('已上传，将作为文件附件发送')).toBeInTheDocument();
  });

  it('上传期间切走，结果落回发起上传的那个会话', async () => {
    let resolveUpload: (v: unknown) => void = () => {};
    fetchMock.mockImplementation(() => new Promise((r) => { resolveUpload = r; }));

    const { rerender, container } = render(<Composer conversation={group} meId="u_lin" onSend={vi.fn()} />);
    pick(container, pdf());
    rerender(<Composer conversation={other} meId="u_lin" onSend={vi.fn()} />);

    await act(async () => {
      resolveUpload({
        ok: true, status: 201,
        text: async () => JSON.stringify({ url: '/uploads/9f3a.bin', filename: '发版清单.pdf', kind: 'file', storage: 'local' }),
      });
      await Promise.resolve();
    });

    // 当前显示的是另一个会话，附件条不该出现在这里。
    expect(screen.queryByText('发版清单.pdf')).not.toBeInTheDocument();
    // 切回去，落在正确的会话上。
    rerender(<Composer conversation={group} meId="u_lin" onSend={vi.fn()} />);
    expect(screen.getByText('发版清单.pdf')).toBeInTheDocument();
    expect(screen.getByText('已上传，将作为文件附件发送')).toBeInTheDocument();
  });
});
