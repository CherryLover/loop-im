// issue #15：正好 8MB（8388608 字节）的图片以前会被前端放行、服务端 413——因为 busboy 的
// limits.fileSize 是「不得达到」语义，服务端实际只放行到 8MB-1。修法是服务端把 limits 抬到
// MAX_UPLOAD_BYTES + 1，以「不超过 8MB 含 8MB」为准；这里从前端一侧把同样的三档边界钉死，
// 保证两边结论一致，也保证这一档不会再白跑一趟服务端。
// 服务端一侧的对照断言在 server/test/issue-15.test.js。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Composer } from './components/Composer';
import { ProfileModal } from './modals/ProfileModal';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from './lib/api';
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
  // 这两个字段是 #14 引入的必填项。本文件来自并行开发的 #17，写的时候 Conversation
  // 还没有它们 —— 两个分支各自都能过，合到一起才发现类型对不上。
  createdBy: 'u_lin',
  unread: 0,
};

const me: User = member('u_lin', '林悦');

/** 造一个指定字节数的图片文件，不真的分配这么多内存。 */
const image = (name: string, size: number) => {
  const file = new File(['x'], name, { type: 'image/png' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

const OVERSIZED_TEXT = `图片大小不能超过 ${MAX_UPLOAD_MB}MB`;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  fetchMock.mockReset();
  // 放行的那几档要真的走到 fetch，所以给一个成功响应，否则会掉进 catch 显示上传失败。
  fetchMock.mockResolvedValue({
    ok: true, status: 201,
    text: async () => JSON.stringify({
      url: '/uploads/a.png', filename: 'edge.png', storage: 'local',
      user: { ...me, avatarUrl: '/uploads/a.png' },
    }),
  });
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

const composer = () => render(<Composer conversation={group} meId="u_lin" onSend={vi.fn()} />);
const profile = () => render(
  <ProfileModal
    me={me} theme="light" onToggleTheme={vi.fn()} onClose={vi.fn()}
    onUpdated={vi.fn()} onSignOut={vi.fn()}
  />,
);
const fileInput = (container: HTMLElement) =>
  container.querySelector('input[type="file"]') as HTMLInputElement;

/** 三个入口各自：把文件喂进去的动作 + 上传成功后界面上出现的那句话。 */
const entries = [
  {
    name: '聊天附件',
    ok: '已上传，将作为图片附件发送',
    feed: (file: File) => {
      const { container } = composer();
      fireEvent.change(fileInput(container), { target: { files: [file] } });
    },
  },
  {
    name: '粘贴图片',
    ok: '已上传，将作为图片附件发送',
    feed: (file: File) => {
      composer();
      fireEvent.paste(screen.getByRole('textbox'), {
        clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
      });
    },
  },
  {
    name: '头像',
    ok: '头像已更新',
    feed: (file: File) => {
      const { container } = profile();
      fireEvent.change(fileInput(container), { target: { files: [file] } });
    },
  },
];

describe('8MB 边界的本地校验', () => {
  it('上限常量就是 8388608 字节', () => {
    expect(MAX_UPLOAD_BYTES).toBe(8388608);
  });

  for (const { name, ok, feed } of entries) {
    it(`${name}：8MB 差一个字节（8388607）放行，上传成功`, async () => {
      feed(image('edge.png', MAX_UPLOAD_BYTES - 1));

      // 本地没拦，请求真的发出去了；服务端这一档返回 201/200，两边结论一致。
      expect(await screen.findByText(ok)).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(screen.queryByText(OVERSIZED_TEXT)).not.toBeInTheDocument();
    });

    it(`${name}：正好 8MB（8388608）放行，上传成功`, async () => {
      // 界面文案写的是「不超过 8MB」，这一档属于合法范围，不该被本地拦下来。
      feed(image('edge.png', MAX_UPLOAD_BYTES));

      expect(await screen.findByText(ok)).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(screen.queryByText(OVERSIZED_TEXT)).not.toBeInTheDocument();
    });

    it(`${name}：超出一个字节（8388609）本地拦下，给中文提示且不发请求`, async () => {
      feed(image('edge.png', MAX_UPLOAD_BYTES + 1));

      expect(await screen.findByText(OVERSIZED_TEXT)).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});
