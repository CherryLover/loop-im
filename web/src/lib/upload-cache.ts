/**
 * 发送端的本地预览缓存：记住「服务端 URL ↔ 本地 blob URL」的对应关系。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 发图的时候，发送方看到图的速度**比接收方还慢**，这不合理。原因是上传成功之后
 * Composer 立刻 revokeObjectURL 把本地 blob 释放掉了，而乐观气泡里放的是服务端
 * 返回的 URL —— 于是发送方要把自己刚传上去的那张图，再从服务端下回来一遍，
 * 而且回源还要过鉴权和 MinIO。等于「上传一趟 + 下载一趟」，原图明明就在手里。
 *
 * 这里把上传成功那一刻的 blob URL 留下来，按服务端 URL 索引。渲染层拿到服务端
 * URL 时先问一句 `localPreviewFor(url) ?? url`：是自己刚发的就直接用内存里的原图，
 * 一个字节都不用走网络；别人发的、或者刷新过页面的，问不到就照常走服务端。
 *
 * ── blob 的生命周期（这是这个模块唯一真正难的地方）─────────────────────
 * blob URL 是**强引用**：只要不 revoke，那份二进制就一直占着内存。把它缓存起来
 * 就等于放弃了「发送成功立刻释放」这个简单规则，所以必须换一个同样明确的规则，
 * 否则发一下午图就把标签页撑爆了。这里的规则是三条：
 *
 *  1. **定容 LRU，满了就淘汰最旧的，淘汰时立刻 revoke。** 这是真正兜底的那一条：
 *     不管用户发多少张图，缓存里永远最多 MAX_ENTRIES 条，内存占用有硬上限。
 *     命中一次会把条目移到最新，所以还在视野里、反复渲染的那几张不会被淘汰掉。
 *  2. **重复写入同一个 serverUrl 时，旧的那份立刻 revoke。** 同一个地址不可能
 *     同时对应两份原图，留着旧的纯属泄漏。
 *  3. **`clearPreviewCache()` 一次性全放掉。** 给退出登录、切换账号这类
 *     「之前发的东西都不该再被看到」的场合用，测试之间也靠它互相隔离。
 *
 * 至于**页面卸载**：不需要额外处理，也刻意不加 unload/pagehide 监听。blob URL 的
 * 作用域就是当前 document，页面一卸载浏览器自己就回收了；加一个只在卸载时跑的
 * 监听器不会少占一个字节内存，反而会让 bfcache 失效。真正的上限来自第 1 条。
 *
 * ── MAX_ENTRIES 为什么是 12 ────────────────────────────────────────────
 * 一次最多能选 9 个附件（见 Composer 的 MAX_ATTACHMENTS），所以缓存至少要装得下
 * 一整批，否则刚发完的一批自己就把自己挤掉了。12 = 一整批 + 3 条余量，够覆盖
 * 「发一批、再补发一两张」这种连续动作，也差不多是一屏聊天记录能同时看见的图数。
 *
 * 只有图片会被写进来（Composer 只对 kind === 'image' 调 rememberPreview）：
 * 图片上限 8MB，最坏 12 × 8MB ≈ 96MB，实际的手机截图通常几百 KB，量级完全可控；
 * 而视频单个就能到 100MB，为了省一次请求把它按在内存里是亏的 —— 何况 <video>
 * 本来就是按 Range 流式播的，并不需要等整个文件下完。
 */

/** 缓存条数上限。见文件头「MAX_ENTRIES 为什么是 12」。 */
const MAX_ENTRIES = 12;

/**
 * 服务端 URL -> 本地 blob URL。
 * Map 的插入顺序就是 LRU 顺序：队头最旧，队尾最新（命中时删了再塞一次即可）。
 */
const cache = new Map<string, string>();

/** jsdom 等环境没有实现 revokeObjectURL，缺了就跳过（和 Composer 里同一套兜底写法）。 */
function revoke(blobUrl: string | undefined) {
  if (blobUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * 索引用的 key：去掉查询串和 hash。
 *
 * 站内附件渲染时会被 attachmentUrl() 拼上 `?token=…`（<img src> 带不了
 * Authorization 头，只能把凭据放进查询串）。存进来的是干净的 `/uploads/9f3a.png`，
 * 查的时候八成是带 token 的那一版，两边不统一就永远查不中。token 还会随着
 * 重新登录变化，把它算进 key 更是自找麻烦 —— 所以两端都只按路径部分索引。
 */
const keyOf = (url: string) => url.split(/[?#]/, 1)[0];

/** 记下「服务端 URL ↔ 本地 blob URL」的对应关系。 */
export function rememberPreview(serverUrl: string, blobUrl: string): void {
  if (!serverUrl || !blobUrl) return;
  const key = keyOf(serverUrl);

  const previous = cache.get(key);
  if (previous === blobUrl) {
    // 同一份，只更新 LRU 位置，别把自己 revoke 掉了。
    cache.delete(key);
    cache.set(key, blobUrl);
    return;
  }
  // 规则 2：同一个地址换了新的原图，旧的那份没人会再看，立刻放掉。
  if (previous) revoke(previous);

  cache.set(key, blobUrl);

  // 规则 1：定容淘汰。Map 的迭代顺序是插入顺序，队头就是最久没被用到的那条。
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    revoke(cache.get(oldest.value));
    cache.delete(oldest.value);
  }
}

/** 拿服务端 URL 换本地 blob URL；没有就返回 null。 */
export function localPreviewFor(url: string): string | null {
  if (!url) return null;
  const key = keyOf(url);
  const blobUrl = cache.get(key);
  if (!blobUrl) return null;
  // 命中即刷新 LRU：正在被反复渲染的那几张要留到最后再淘汰。
  cache.delete(key);
  cache.set(key, blobUrl);
  return blobUrl;
}

/**
 * 全部释放并清空。用在退出登录、切换账号这类「之前发的东西都不该再看到」的场合；
 * 测试之间也靠它互相隔离，免得上一个用例留下的条目串到下一个。
 */
export function clearPreviewCache(): void {
  for (const blobUrl of cache.values()) revoke(blobUrl);
  cache.clear();
}

/** 当前缓存了几条。只给测试和排查用，不参与业务逻辑。 */
export const previewCacheSize = (): number => cache.size;
