// issue #9：超过 8MB 的图片以前直接发给服务端，界面上只能看到 multer 的英文提示，
// 而且选图前没有任何上限说明。这里锁住「上传前本地拦截 + 中文提示 + 界面写明 8MB」。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Composer } from './components/Composer';
import { ProfileModal } from './modals/ProfileModal';
import { MAX_UPLOAD_MB } from './lib/api';
import type { Conversation, User } from './lib/types';

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
};

const me: User = member('u_lin', '林悦');

/** 造一个「体积超限」的图片文件，不真的分配 9MB 内存。 */
const image = (name: string, mb: number) => {
  const file = new File(['x'], name, { type: 'image/png' });
  Object.defineProperty(file, 'size', { value: Math.round(mb * 1024 * 1024) });
  return file;
};

const oversized = () => image('big.png', MAX_UPLOAD_MB + 1);
const fetchMock = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

const composer = () => render(<Composer conversation={group} meId="u_lin" onSend={vi.fn()} />);
const fileInput = (container: HTMLElement) =>
  container.querySelector('input[type="file"]') as HTMLInputElement;

describe('超过 8MB 的图片', () => {
  it('选图时本地就拦下来，给中文提示且不发请求', async () => {
    const { container } = composer();
    fireEvent.change(fileInput(container), { target: { files: [oversized()] } });

    expect(await screen.findByText(`图片大小不能超过 ${MAX_UPLOAD_MB}MB`)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('粘贴图片走同一套校验', async () => {
    const file = oversized();
    const { container } = composer();
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
    });

    expect(await screen.findByText(`图片大小不能超过 ${MAX_UPLOAD_MB}MB`)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    // 附件条上仍然可以移除失败的附件，重新选一张。
    fireEvent.click(screen.getByTitle('移除附件'));
    expect(screen.queryByText(`图片大小不能超过 ${MAX_UPLOAD_MB}MB`)).not.toBeInTheDocument();
    expect(container.querySelector('.attach')).toBeNull();
  });

  it('头像上传也一样', async () => {
    const { container } = render(
      <ProfileModal
        me={me} theme="light" onToggleTheme={vi.fn()} onClose={vi.fn()}
        onUpdated={vi.fn()} onSignOut={vi.fn()}
      />,
    );
    fireEvent.change(fileInput(container), { target: { files: [oversized()] } });

    expect(await screen.findByText(`图片大小不能超过 ${MAX_UPLOAD_MB}MB`)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('没超限的图片照常发起上传', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 201,
      text: async () => JSON.stringify({ url: '/uploads/a.png', filename: 'ok.png', storage: 'local' }),
    });
    const { container } = composer();
    fireEvent.change(fileInput(container), { target: { files: [image('ok.png', 1)] } });

    expect(await screen.findByText('已上传，将作为图片附件发送')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('上限提示', () => {
  it('输入框和个人资料都写明了 8MB 上限', () => {
    composer();
    expect(screen.getByTitle(`从本地选择图片（不超过 ${MAX_UPLOAD_MB}MB）`)).toBeInTheDocument();

    render(
      <ProfileModal
        me={me} theme="light" onToggleTheme={vi.fn()} onClose={vi.fn()}
        onUpdated={vi.fn()} onSignOut={vi.fn()}
      />,
    );
    expect(screen.getByText(`图片不超过 ${MAX_UPLOAD_MB}MB`)).toBeInTheDocument();
  });
});
