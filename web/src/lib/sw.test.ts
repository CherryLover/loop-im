/**
 * Service Worker 注册的三条路径。
 *
 * 这个模块只有十来行，但它跑在**页面启动路径**上，所以真正要锁的不是「注册成功」，
 * 而是另外两条：环境不支持、注册失败。这两条各自都得安静地返回 null。
 * 只要有一条会抛，用户就会因为一个「装不上推送」的次要功能而看到白屏 ——
 * 而没有 SW，这个网页照样是个完全能用的 IM。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './sw';

/**
 * jsdom 没有 navigator.serviceWorker，所以「不支持」是这里的**默认状态**，
 * 要测「支持」反而得自己装一个上去。configurable: true 是为了 afterEach 能删干净：
 * 用例之间漏一个假的 serviceWorker 出去，别的文件会莫名其妙。
 */
function installServiceWorkerApi(register: () => Promise<unknown>) {
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register: vi.fn(register) },
    configurable: true,
    writable: true,
  });
  return navigator.serviceWorker.register as unknown as ReturnType<typeof vi.fn>;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // 默认吞掉 warn：下面有用例是**故意**触发失败路径的，让它真的打到测试输出里
  // 只会让人以为跑挂了。要断言的用例自己看 warn.mock.calls。
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  // @ts-expect-error 测试里要把这个假属性摘干净，jsdom 上它本来就不存在
  delete navigator.serviceWorker;
});

describe('registerServiceWorker', () => {
  it('注册成功时，用 /sw.js 和 scope /，并把 registration 返回出来', async () => {
    const registration = { scope: 'http://localhost:3000/' };
    const register = installServiceWorkerApi(async () => registration);

    const result = await registerServiceWorker();

    // 路径和 scope 都是硬要求，不是随便填的：路径变了就等于换了一个 SW（浏览器按 URL
    // 认），scope 小了推送点开就落不到站内任意路由。所以逐字断言，不用 objectContaining。
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    // 返回的是 await 之后的 registration，不是一个还没解开的 Promise ——
    // 调用方（PR2 的 push 订阅）要直接从它身上摸 pushManager。
    expect(result).toBe(registration);
  });

  it('浏览器没有 serviceWorker 时返回 null，不抛也不 warn', async () => {
    // jsdom 的原生状态，正是 CI 上每次跑测试的状态。
    expect('serviceWorker' in navigator).toBe(false);

    await expect(registerServiceWorker()).resolves.toBeNull();
    // 这是预期内的降级，不是故障。每跑一次测试刷一行警告，只会让真正的警告被淹掉。
    expect(warn).not.toHaveBeenCalled();
  });

  it('register 抛异常时返回 null 并 warn，绝不把异常抛给调用方', async () => {
    // 真实世界里这条最常见：sw.js 被 SPA catch-all 兜成了 HTML（MIME 不对）、
    // 或者构建产物里压根没有这个文件（404）。
    const boom = new Error("The script has an unsupported MIME type ('text/html')");
    const register = installServiceWorkerApi(async () => {
      throw boom;
    });

    await expect(registerServiceWorker()).resolves.toBeNull();

    expect(register).toHaveBeenCalledTimes(1);
    // warn 得带上原始错误，否则真机上只看到一句「注册失败」，等于没说。
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toContain(boom);
  });

  it('register 同步抛（而不是 reject）时也一样兜得住', async () => {
    // 分开一条：try 包住的是 await 表达式，同步抛和异步 reject 走的是同一条 catch，
    // 但这依赖 register 调用本身在 try 块里。哪天有人把它挪到 try 外面去算 URL，
    // 这条会红，而上面那条不会。
    installServiceWorkerApi(() => {
      throw new Error('SecurityError');
    });

    await expect(registerServiceWorker()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
