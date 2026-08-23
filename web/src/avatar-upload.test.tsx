// 头像上传的中间状态。
//
// 用户反馈「选择图片后一直在 loading」。复现下来真实情况是**一点 loading 都没有**：
// 从选中文件到请求结束，个人资料弹窗的 DOM 一个字都不变，「上传新头像」按钮还照样能点，
// 于是「界面毫无反应」被理解成「卡在 loading」。这里把三态钉死：
// 上传中有明确表现且按钮锁住 → 成功有明确反馈 → 失败有原因 + 能重试。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileModal } from './modals/ProfileModal';
import { MAX_UPLOAD_MB } from './lib/api';
import type { User } from './lib/types';

const me: User = {
  id: 'u_lin', name: '林悦', email: 'lin@loop.dev', dept: '产品',
  role: 'member', avatarUrl: null, isAI: false, online: true,
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const onUpdated = vi.fn();

const profile = () => render(
  <ProfileModal
    me={me} theme="light" onToggleTheme={vi.fn()} onClose={vi.fn()}
    notifyEnabled={false} notifyPermission="unsupported" onToggleNotify={vi.fn()}
    onUpdated={onUpdated} onSignOut={vi.fn()}
  />,
);

const image = (name = 'me.png', size = 1024) => {
  const file = new File(['x'], name, { type: 'image/png' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

/** 选一张图片。走 upload 事件而不是 change：userEvent.upload 会自己填好 files。 */
const pick = (container: HTMLElement, file: File) =>
  userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file);

const okResponse = () => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ user: { ...me, avatarUrl: '/uploads/a.png' } }),
});

describe('选中图片之后立刻有「上传中」', () => {
  it('请求还挂着的时候，界面已经在说上传中，按钮也点不动了', async () => {
    let release: () => void = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => { release = () => resolve(okResponse()); }));
    const { container } = profile();

    await pick(container, image('头像.png'));

    // 这三条就是「选完图片什么都没发生」的反面
    expect(await screen.findByText('正在上传 头像.png…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传中…' })).toBeDisabled();
    expect(container.querySelector('.avatar-slot--busy')).not.toBeNull();

    release();
    expect(await screen.findByText('头像已更新')).toBeInTheDocument();
  });

  it('上传中的状态挂在 aria-live 上，不盯着看也能被读屏播报', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { container } = profile();

    await pick(container, image());

    const live = await screen.findByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('正在上传 me.png…');
  });
});

describe('成功和失败都有明确反馈', () => {
  it('成功：给出「头像已更新」，并把新用户对象交回上层', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const { container } = profile();

    await pick(container, image());

    expect(await screen.findByText('头像已更新')).toBeInTheDocument();
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: '/uploads/a.png' }));
    // 中间态收干净了：按钮回到可点，转圈没了
    expect(screen.getByRole('button', { name: '上传新头像' })).toBeEnabled();
    expect(container.querySelector('.avatar-slot__spinner')).toBeNull();
  });

  it('失败：说明原因，并且就在头像旁边给一个「重试」', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { container } = profile();

    await pick(container, image());

    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    // 失败之后不能还卡在「上传中」
    expect(screen.getByRole('button', { name: '上传新头像' })).toBeEnabled();
  });

  it('重试用的是同一张图，不用再点一遍文件选择框', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { container } = profile();
    await pick(container, image('原图.png'));
    await screen.findByRole('button', { name: '重试' });

    fetchMock.mockResolvedValue(okResponse());
    await userEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByText('头像已更新')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 重试路径也走同一个 /auth/me/avatar，没有绕过体积校验
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/me/avatar');
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  });

  it('本地就被体积拦下时也是失败态：原样给中文提示，且没发请求', async () => {
    const { container } = profile();

    await pick(container, image('big.png', (MAX_UPLOAD_MB + 1) * 1024 * 1024));

    expect(await screen.findByText(`文件大小不能超过 ${MAX_UPLOAD_MB}MB`)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('重新选一张图会把上一次的失败清掉，不会两条状态叠在一起', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { container } = profile();
    await pick(container, image('坏的.png'));
    await screen.findByText('Failed to fetch');

    fetchMock.mockResolvedValue(okResponse());
    await pick(container, image('好的.png'));

    await waitFor(() => expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument());
    expect(await screen.findByText('头像已更新')).toBeInTheDocument();
  });
});
