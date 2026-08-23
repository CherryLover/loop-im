/**
 * 发送端本地预览缓存。
 *
 * 自己刚上传成功的那张图，本地内存里还留着一份 blob。渲染时优先用本地这份，
 * 就不用为了看自己刚发出去的东西再从服务端下回来一遍。
 *
 * 这个模块只是**一张表**：写入那一侧（上传成功后调 rememberPreview）由 Composer /
 * 上传流程接上，读出那一侧（md.ts 渲染图片和视频时调 localPreviewFor）已经接好了。
 * 两边都不认识对方，唯一的约定就是下面这个 key。
 *
 * ## key 怎么定
 *
 * 用服务端返回的那个 URL，但**先切掉 ?query 和 #hash**。原因是同一个附件在不同地方
 * 形态不一样：消息正文里存的是裸的 `/uploads/<uuid>.png`，真正塞进 <img src> 的那个
 * 是 attachmentUrl() 拼过 `?token=…` 的版本，而 token 会随登录态变。按裸路径做 key，
 * 写入方传哪一种都能命中，token 换了也不会把缓存打散。
 *
 * ## 为什么只认 blob:
 *
 * 这张表的 key 来自消息正文，而正文是用户手打的。值这一侧限定必须是 blob:，
 * 万一将来有谁把不该进来的东西写进来，也变不成 `javascript:` 之类能执行的 URL
 * —— md.ts 的 safeUrl() 只管它自己那条路径，管不到这里换进去的值。
 */

const previews = new Map<string, string>();

/** 统一 key：只保留路径部分，?token= 之类一律不参与比对。 */
const keyOf = (url: string) => String(url || '').replace(/[?#].*$/, '');

/**
 * 记下「服务端 URL → 本地 blob URL」。
 *
 * serverUrl 带不带 ?token= 都行。blobUrl 必须是 URL.createObjectURL() 造出来的
 * blob: 地址，别的一律忽略（静默丢弃，不抛错：这条路径在发消息的主流程上，
 * 一个缓存写失败不该把消息发送整个搞挂）。
 */
export function rememberPreview(serverUrl: string, blobUrl: string): void {
  const key = keyOf(serverUrl);
  if (!key || !/^blob:/i.test(String(blobUrl || ''))) return;
  previews.set(key, blobUrl);
}

/** 拿服务端 URL 换本地 blob URL；没有就返回 null。 */
export function localPreviewFor(url: string): string | null {
  const hit = previews.get(keyOf(url));
  return hit && /^blob:/i.test(hit) ? hit : null;
}
