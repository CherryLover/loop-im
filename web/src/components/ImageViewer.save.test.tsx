/**
 * 保存这条链路：顶栏下载按钮、长按弹菜单、菜单里的分享 / 下载 / 取消。
 *
 * jsdom 没有真下载，能钉住的是「fetch 了正确的地址、造出的 <a download> 名字对、
 * 分享时交出去的 File 对」。真实的相册落盘只能真机上验。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImageViewer } from './ImageViewer';

function mockImageAlreadyLoaded() {
  Object.defineProperty(HTMLImageElement.prototype, 'complete', {
    configurable: true,
    get() { return !!this.getAttribute('src'); },
  });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
    configurable: true,
    get() { return 100; },
  });
}

/** jsdom 的 URL 上没有 createObjectURL，补一对可断言的桩。 */
function mockObjectUrl() {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:mock-url') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
}

afterEach(() => {
  Reflect.deleteProperty(HTMLImageElement.prototype, 'complete');
  Reflect.deleteProperty(HTMLImageElement.prototype, 'naturalWidth');
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
  Reflect.deleteProperty(navigator, 'share');
  Reflect.deleteProperty(navigator, 'canShare');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const img = () => document.body.querySelector('img.imgview__img') as HTMLImageElement;
const at = (x: number, y: number) => ({ clientX: x, clientY: y });

function open() {
  mockImageAlreadyLoaded();
  return render(
    <ImageViewer
      images={[{ src: '/uploads/9f3a.png?token=abc', alt: '发版流程' }]}
      index={0}
      onIndex={() => {}}
      onClose={() => {}}
    />,
  );
}

function stubFetchOk(type = 'image/jpeg') {
  const fetchSpy = vi.fn(async () => ({
    ok: true,
    blob: async () => new Blob(['x'], { type }),
  }));
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

/** 长按大图 500ms，把保存菜单弹出来。计时器是假的，弹完就换回真的。 */
function longPress() {
  vi.useFakeTimers();
  fireEvent.touchStart(img(), { touches: [at(200, 200)] });
  act(() => { vi.advanceTimersByTime(500); });
  vi.useRealTimers();
}

/** 把环境伪装成触屏设备：(pointer: coarse) 命中，其余查询（如 reduced-motion）不命中。 */
function mockCoarsePointer() {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query === '(pointer: coarse)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })));
}

/** 把环境伪装成支持 Web Share 分享文件，返回 share 的桩以便断言。 */
function mockFileShare(share: (data: unknown) => Promise<void> = async () => {}) {
  const shareSpy = vi.fn(share);
  Object.defineProperty(navigator, 'share', { configurable: true, value: shareSpy });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  return shareSpy;
}

describe('顶栏的下载按钮', () => {
  it('取回原图、按「alt + 实际 MIME」起名触发下载', async () => {
    const fetchSpy = stubFetchOk('image/jpeg');
    mockObjectUrl();
    let captured: { download: string; href: string } | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      captured = { download: this.download, href: this.href };
    });

    open();
    fireEvent.click(screen.getByRole('button', { name: '下载图片' }));

    await waitFor(() => expect(captured).not.toBeNull());
    // 下载的必须是**原地址**（token 一个字不能少，少了 401），不是另拼一个
    expect(fetchSpy).toHaveBeenCalledWith('/uploads/9f3a.png?token=abc');
    expect(captured!.download).toBe('发版流程.jpg');
    expect(captured!.href).toContain('blob:mock-url');
  });

  it('取图失败时说出来，而不是无声无息', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    open();
    fireEvent.click(screen.getByRole('button', { name: '下载图片' }));
    expect(await screen.findByText('图片保存失败，稍后再试')).toBeInTheDocument();
  });
});

describe('手机上的顶栏保存按钮（触屏 + 支持分享文件）', () => {
  it('按钮变成「保存图片」，点了交给系统分享面板（iOS 从这里存相册）', async () => {
    mockCoarsePointer();
    const shareSpy = mockFileShare();
    stubFetchOk('image/png');

    open();
    // 走分享的路，就不该再自称「下载」
    expect(screen.queryByRole('button', { name: '下载图片' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存图片' }));

    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    const shared = (shareSpy.mock.calls[0] as unknown[])[0] as { files: File[] };
    expect(shared.files[0]?.name).toBe('发版流程.png');
  });

  it('分享面板起不来（NotAllowedError）就退回下载，这一按不能什么都没发生', async () => {
    mockCoarsePointer();
    mockFileShare(async () => {
      throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    });
    stubFetchOk('image/jpeg');
    mockObjectUrl();
    let captured: string | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      captured = this.download;
    });

    open();
    fireEvent.click(screen.getByRole('button', { name: '保存图片' }));

    await waitFor(() => expect(captured).toBe('发版流程.jpg'));
    expect(screen.queryByText('图片保存失败，稍后再试')).toBeNull();
  });

  it('用户自己划掉分享面板不算失败：不报错，按钮恢复可点', async () => {
    mockCoarsePointer();
    const shareSpy = mockFileShare(async () => {
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    });
    stubFetchOk('image/png');

    open();
    fireEvent.click(screen.getByRole('button', { name: '保存图片' }));

    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: '保存图片' })).toBeEnabled());
    expect(screen.queryByText('图片保存失败，稍后再试')).toBeNull();
  });

  it('触屏但系统分享不了文件：按钮保持「下载图片」，仍走下载', () => {
    mockCoarsePointer();
    open();
    expect(screen.getByRole('button', { name: '下载图片' })).toBeInTheDocument();
  });
});

describe('长按大图弹保存菜单', () => {
  it('按住 500ms 弹出；系统不支持分享文件时只有下载和取消', () => {
    open();
    longPress();
    expect(screen.getByText('下载到本地')).toBeInTheDocument();
    expect(screen.queryByText('保存到相册 / 分享…')).toBeNull();
    // 取消收起菜单
    fireEvent.click(screen.getByText('取消'));
    expect(screen.queryByText('下载到本地')).toBeNull();
  });

  it('按住中途手指走了就不弹（那是在划动，不是长按）', () => {
    open();
    vi.useFakeTimers();
    fireEvent.touchStart(img(), { touches: [at(200, 200)] });
    fireEvent.touchMove(img(), { touches: [at(240, 200)] });
    act(() => { vi.advanceTimersByTime(500); });
    vi.useRealTimers();
    expect(screen.queryByText('下载到本地')).toBeNull();
  });

  it('按在背景上长按不弹菜单（没有可保存的东西）', () => {
    open();
    vi.useFakeTimers();
    fireEvent.touchStart(document.body.querySelector('.imgview') as HTMLElement, { touches: [at(20, 20)] });
    act(() => { vi.advanceTimersByTime(500); });
    vi.useRealTimers();
    expect(screen.queryByText('下载到本地')).toBeNull();
  });

  it('Esc 先关菜单，不是一杆子把预览捅掉', () => {
    // 组件是受控的：关没关由调用方定，这里盯的是 onClose 在**第几下** Esc 被调。
    const onClose = vi.fn();
    mockImageAlreadyLoaded();
    render(
      <ImageViewer
        images={[{ src: '/uploads/9f3a.png?token=abc', alt: '发版流程' }]}
        index={0}
        onIndex={() => {}}
        onClose={onClose}
      />,
    );
    longPress();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('下载到本地')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    // 菜单没了之后 Esc 才轮到关预览
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('支持分享文件的环境多一个「保存到相册 / 分享…」，交出去的是取回的图', async () => {
    const shareSpy = vi.fn(async () => {});
    Object.defineProperty(navigator, 'share', { configurable: true, value: shareSpy });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    stubFetchOk('image/png');

    open();
    longPress();
    fireEvent.click(screen.getByText('保存到相册 / 分享…'));

    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    const shared = (shareSpy.mock.calls[0] as unknown[])[0] as { files: File[] };
    expect(shared.files[0]?.name).toBe('发版流程.png');
    // 分享面板交出去之后菜单就该收起来了
    await waitFor(() => expect(screen.queryByText('取消')).toBeNull());
  });
});
