/**
 * Service Worker 的注册。
 *
 * 只做一件事：把 /sw.js 注册上。它本身什么都不做（见 public/sw.js 顶部的红线注释），
 * 装它纯粹是因为 Web Push 的入口 PushManager 挂在 ServiceWorkerRegistration 上 ——
 * iOS 上没有 SW 就连 subscribe() 都发起不了。
 *
 * 一条原则贯穿全文件：**注册失败绝不能影响页面**。
 * 没有 SW，网页照样是个完全能用的 IM，只是收不到后台推送。所以这里没有任何
 * 抛出路径，最坏的情况也只是 console.warn 一句然后返回 null。
 */

/** SW 脚本的路径。放在 web/public/ 下，Vite 原样拷进 dist 根目录、不加 hash —— */
/*  路径必须稳定，浏览器是按 URL 认 SW 的，换个名字就等于换了一个 SW。 */
const SW_URL = '/sw.js';

/**
 * scope 显式写成 '/'，虽然它正好也是默认值（默认 scope = 脚本所在目录）。
 *
 * 写出来是因为这个值是**语义要求**而不是巧合：SW 只能管到自己 scope 内的页面，
 * 而推送通知点开后要能落到站内任意路由。写死它，将来谁把 sw.js 挪进子目录，
 * 会当场收到一个 SecurityError（超出脚本目录的 scope 需要服务端发
 * Service-Worker-Allowed 头），而不是安静地缩小成半个站。
 */
const SW_SCOPE = '/';

/**
 * 注册 Service Worker。
 *
 * @returns 注册成功返回 registration；环境不支持或注册失败一律返回 null，绝不抛。
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  // jsdom、老浏览器、以及非安全上下文（http:// 访问内网 IP）下都没有这个属性。
  // 这不是错误，是预期内的降级，所以连 warn 都不打 —— 每次跑测试刷一行警告纯属噪音。
  if (!('serviceWorker' in navigator)) return null;

  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  } catch (err) {
    // 真到这儿说明是环境问题：MIME 类型不对（被 SPA catch-all 兜成 HTTP 200 + HTML）、
    // 404、或者 scope 越界。这些都得让人看见，但都不值得把页面搞挂。
    console.warn('[loop-im] Service Worker 注册失败，推送将不可用', err);
    return null;
  }
}
