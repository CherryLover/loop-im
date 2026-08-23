/**
 * 发送端本地预览缓存。
 *
 * 用户反馈的问题：发图时**发送方**比接收方看到得还慢。接收端只是加载一个链接的
 * preview，发送端明明有原图 —— 却因为上传成功就 revoke 掉了本地 blob，只能拿着
 * 服务端 URL 再下回来一遍（还要过鉴权和 MinIO）。这个模块把原图留下来。
 *
 * 留下来就意味着放弃「发完立刻释放」这条简单规则，所以这里重点锁两件事：
 *   1. 该命中的要命中（包括渲染时被拼上 ?token= 的那一版）；
 *   2. **内存有硬上限** —— 定容 LRU，淘汰的那条一定被 revoke 掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPreviewCache, localPreviewFor, previewCacheSize, rememberPreview } from './upload-cache';

/** 和实现里的 MAX_ENTRIES 一致：一整批（9 个附件）加 3 条余量。 */
const MAX_ENTRIES = 12;

beforeEach(() => {
  clearPreviewCache();
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

describe('记住与查回', () => {
  it('记下之后能用服务端 URL 换回本地 blob URL', () => {
    rememberPreview('/uploads/9f3a.png', 'blob:local-1');
    expect(localPreviewFor('/uploads/9f3a.png')).toBe('blob:local-1');
  });

  it('没记过的返回 null，调用方 `localPreviewFor(url) ?? url` 自然退回服务端地址', () => {
    expect(localPreviewFor('/uploads/别人发的.png')).toBeNull();
  });

  it('空串不会污染缓存', () => {
    rememberPreview('', 'blob:local-1');
    rememberPreview('/uploads/a.png', '');
    expect(previewCacheSize()).toBe(0);
    expect(localPreviewFor('')).toBeNull();
  });

  it('带 ?token= 的那一版也能命中：渲染时 attachmentUrl 会把凭据拼进查询串', () => {
    // <img src> 带不了 Authorization 头，站内附件地址渲染时会变成
    // /uploads/9f3a.png?token=… —— 两端都只按路径索引，才不会永远查不中。
    rememberPreview('/uploads/9f3a.png', 'blob:local-1');
    expect(localPreviewFor('/uploads/9f3a.png?token=tok-abc')).toBe('blob:local-1');
    expect(localPreviewFor('/uploads/9f3a.png#frag')).toBe('blob:local-1');
  });

  it('存进来的地址自己带 token 时也归一化，换个 token 照样命中', () => {
    // 重新登录会换一个 token，把它算进 key 等于每次登录后缓存全失效。
    rememberPreview('/uploads/9f3a.png?token=old', 'blob:local-1');
    expect(localPreviewFor('/uploads/9f3a.png?token=new')).toBe('blob:local-1');
  });

  it('不同的服务端地址各存各的，不会串', () => {
    rememberPreview('/uploads/a.png', 'blob:a');
    rememberPreview('/uploads/b.png', 'blob:b');
    expect(localPreviewFor('/uploads/a.png')).toBe('blob:a');
    expect(localPreviewFor('/uploads/b.png')).toBe('blob:b');
  });
});

describe('blob 不会无限占着内存', () => {
  it('同一个地址换了新原图，旧的那份立刻释放', () => {
    rememberPreview('/uploads/a.png', 'blob:old');
    rememberPreview('/uploads/a.png', 'blob:new');

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old');
    expect(localPreviewFor('/uploads/a.png')).toBe('blob:new');
    expect(previewCacheSize()).toBe(1);
  });

  it('原样重写同一份不会把自己 revoke 掉', () => {
    rememberPreview('/uploads/a.png', 'blob:same');
    rememberPreview('/uploads/a.png', 'blob:same');

    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(localPreviewFor('/uploads/a.png')).toBe('blob:same');
  });

  it(`条数封顶在 ${MAX_ENTRIES}：这就是内存的硬上限`, () => {
    for (let i = 0; i < MAX_ENTRIES * 3; i += 1) rememberPreview(`/uploads/${i}.png`, `blob:${i}`);
    expect(previewCacheSize()).toBe(MAX_ENTRIES);
  });

  it('淘汰最旧的那条，并且**真的** revoke 掉它的 blob（只删表不释放等于泄漏）', () => {
    for (let i = 0; i < MAX_ENTRIES; i += 1) rememberPreview(`/uploads/${i}.png`, `blob:${i}`);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    rememberPreview('/uploads/new.png', 'blob:new');

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:0');
    expect(localPreviewFor('/uploads/0.png')).toBeNull();
    expect(localPreviewFor('/uploads/1.png')).toBe('blob:1');
    expect(localPreviewFor('/uploads/new.png')).toBe('blob:new');
  });

  it('装得下一整批（9 个附件），刚发完的一批不会自己把自己挤掉', () => {
    for (let i = 0; i < 9; i += 1) rememberPreview(`/uploads/batch-${i}.png`, `blob:batch-${i}`);
    for (let i = 0; i < 9; i += 1) expect(localPreviewFor(`/uploads/batch-${i}.png`)).toBe(`blob:batch-${i}`);
  });

  it('命中会刷新 LRU：还在反复渲染的那张留到最后才淘汰', () => {
    for (let i = 0; i < MAX_ENTRIES; i += 1) rememberPreview(`/uploads/${i}.png`, `blob:${i}`);
    expect(localPreviewFor('/uploads/0.png')).toBe('blob:0');   // 0 被看了一眼，变成最新

    rememberPreview('/uploads/new.png', 'blob:new');

    expect(localPreviewFor('/uploads/0.png')).toBe('blob:0');   // 活下来了
    expect(localPreviewFor('/uploads/1.png')).toBeNull();       // 换成 1 被淘汰
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
  });

  it('clearPreviewCache 把所有 blob 一次放掉（退出登录、换账号）', () => {
    rememberPreview('/uploads/a.png', 'blob:a');
    rememberPreview('/uploads/b.png', 'blob:b');

    clearPreviewCache();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:b');
    expect(previewCacheSize()).toBe(0);
    expect(localPreviewFor('/uploads/a.png')).toBeNull();
  });
});

describe('环境兜底', () => {
  it('没有 revokeObjectURL 实现时（某些 jsdom）不抛异常，功能照常', () => {
    const original = URL.revokeObjectURL;
    // @ts-expect-error 故意把实现拿掉，模拟没有这个 API 的环境
    delete URL.revokeObjectURL;
    try {
      expect(() => {
        rememberPreview('/uploads/a.png', 'blob:a');
        rememberPreview('/uploads/a.png', 'blob:a2');
        clearPreviewCache();
      }).not.toThrow();
    } finally {
      URL.revokeObjectURL = original;
    }
  });
});
