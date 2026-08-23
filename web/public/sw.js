// Loop IM 的 Service Worker。
//
// 目前它什么都不做。这是有意的：先把注册、scope、MIME、缓存头这些**部署层面**的坑
// 在没有任何业务逻辑的时候趟平，推送逻辑（push / notificationclick）后面再往里加。
// SW 的部署问题和推送逻辑的问题症状很像（都表现为「收不到通知」），
// 混在一起真机排查会非常痛苦。
//
// ── 红线：这个文件里永远不许出现 fetch 事件监听 ──────────────────────
// 我们要 Service Worker，只是为了 Web Push —— iOS 上不注册 SW，连 subscribe() 都发起
// 不了，因为 PushManager 挂在 ServiceWorkerRegistration 上。仅此而已。
//
// 一旦加了 fetch handler，页面资源就会走 SW 的网络路径和缓存策略，而这个项目刚吃过
// 「静默缓存导致用户看到旧界面、没有任何报错」的亏（见 src/styles-integrity.test.js
// 顶部那段事故说明，同一类问题：不报错，但行为不对）。
// 没有 fetch handler = 所有请求原样走网络 = 缓存行为和没有 SW 时逐字节相同，风险为零。
// 这不是「靠人自觉不写缓存代码」，而是**结构上不可能**：浏览器压根不会把请求交给我们。
//
// 代价说清楚：没有 fetch handler 就没有离线能力。对一个 IM 来说这个代价是零 ——
// 离线打开一个连消息都拉不到的空壳，没有任何意义。离线可用不在本项目的目标里。
//
// src/sw-source.test.js 会读这个文件的源码，断言里面没有任何 'fetch' 监听。
// 想加缓存请先删掉那条闸门并说明理由 —— 那时你就得对着这段注释想清楚。
// ───────────────────────────────────────────────────────────────────

// 装上就立刻接管，不等所有旧页面关掉。
// 我们不缓存任何东西，所以「新旧 SW 并存」没有半点好处，只会让排查变复杂：
// 真机上看到的到底是哪一版 SW 在跑，是个纯粹多余的问题。
self.addEventListener('install', () => self.skipWaiting());

// 同理，激活后立刻接管已经打开的页面，不必等用户手动刷新。
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
