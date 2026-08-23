# PWA 与推送改造方案

> 目标：让 iPhone / iPad 上的用户「添加到主屏幕」之后，像用原生 App 一样收到新消息提醒——
> 应用没开、屏幕锁着，通知照样到。
>
> 这份文档要能被几个并行的实现 Agent 直接照着干活，所以：**每条事实带出处**，
> **每个任务包写清独占哪些文件**，**查不到确证的一律写「未确证」，不用听起来合理的说法填空**。

编写日期：2026-08-23 · 基线：`98d4d97` · 分支：`docs/pwa-plan`

---

## 0. 一句话结论

现在的桌面通知（`web/src/lib/notify.ts` 里的 `new Notification()`）在 iOS 上**一行都跑不到**：
Safari 标签页里 `Notification` 这个标识符压根不存在。要让 iPad / iPhone 收到提醒，
必须同时满足三件事，缺一件就全盘无效：

1. 用户把站点**添加到主屏幕**，且我们提供的 manifest 里 `display` 是 `standalone`／`fullscreen`；
2. 注册一个 **Service Worker**，并用 `PushManager.subscribe()` 拿到订阅；
3. 服务端按 **VAPID + RFC 8291** 把加密后的消息推到订阅给的 endpoint。

第 3 步是真正的重头戏：iOS 不给网页后台执行权，`EventSource`（我们的 SSE）在 PWA 被挂起
的那一刻就断了，所以「前端收到 SSE 再自己弹通知」这条路在 iOS 上覆盖不到最该覆盖的那一档。
**「该不该弹」这个判断必须整体搬到服务端。**

---

## A. 事实与前提

### A.1 十条待核查项，逐条核实

主 Agent 给出的十条判断，下面逐条独立核查。**有三条不准确，一条明确错误。**

---

#### ① 普通 iOS Safari 标签页里没有 `Notification` 对象，只有主屏 Web App 才有

**✅ 正确，但要补一个前提。**

MDN 浏览器兼容数据（BCD）对 `safari_ios` 的 `Notification` 接口记录是：

> The `Notification` interface is undefined, unless the page is a web app saved to the home screen.
> **The app's manifest must have a non-default `display` value.**

补的这一句很关键：**光「加到主屏幕」还不够**——manifest 的 `display` 必须是非默认值
（`browser` 是默认值，不算）。也就是说，今天用户就算把 Loop IM 加到主屏，因为我们
**根本没有 manifest**，`Notification` 仍然是 undefined。

`caniuse` 对 Safari on iOS 的记录是 3.2–16.3「不支持」、16.4 起「部分支持」，与 BCD 一致。

出处：
- <https://github.com/mdn/browser-compat-data/blob/main/api/Notification.json>
- <https://caniuse.com/notifications>

**对现有代码的影响**：`notify.ts` 的 `notifySupported()` 用 `typeof Notification !== 'undefined'`，
这个写法本身是安全的（`typeof` 对未声明的全局不抛），所以 iOS 上不会崩，只会静默降级成
`'unsupported'`——然后 ProfileModal 显示「当前浏览器不支持桌面通知」。**这句话是错的**，
用户换任何浏览器都一样（iOS 上所有浏览器都是 WebKit），真正该说的是「先添加到主屏幕」。
这就是任务包 1C 要修的那句误导性提示。

---

#### ② 即使装了，`new Notification()` 在移动端会抛 `TypeError`，必须用 `ServiceWorkerRegistration.showNotification()`

**⚠️ 原判断有误（部分）。结论对，理由错。**

要拆成两个上下文说：

**在 Service Worker 全局作用域里** —— 抛 `TypeError` 是**规范明文规定**的，永远成立。
Notifications 规范构造步骤第一步：

> If this's relevant global object is a `ServiceWorkerGlobalScope` object, then throw a `TypeError`.

出处：<https://notifications.spec.whatwg.org/>

**在页面里** —— MDN 那句广为流传的警告是：

> This constructor throws a `TypeError` when called in nearly all mobile browsers.

出处：<https://developer.mozilla.org/en-US/docs/Web/API/Notification/Notification>

但 MDN 自己的 BCD 对 `safari_ios` 的**构造函数**条目写的是 `version_added: "16.4"`，注释是：

> This constructor throws a **`ReferenceError`** exception, unless the page is a web app saved to the home screen.

注意两点：抛的是 `ReferenceError` 而不是 `TypeError`（因为标识符不存在，不是构造器非法），
而且 BCD 把「装到主屏之后」记成**支持**。也就是说「装了之后页面里 `new Notification()`
照样抛」这个说法**找不到依据，而且与 BCD 相反**。那句 `TypeError` 警告主要针对的是
Android Chrome（那里确实是 `Illegal constructor`）。

**未确证**：iOS 主屏 Web App 的页面上下文里 `new Notification()` 到底能不能真的弹出来。
BCD 说能，但我没找到 WebKit 官方的正面表述，也没有真机。**列入真机验收清单（TC-PWA-11）。**

**但最终结论不变：统一改用 `registration.showNotification()`。** 理由换成这三条：
- Android Chrome 的页面里 `new Notification()` 确实会抛，一套代码要能跨端；
- 推送到达时代码跑在 SW 里，那里**只能**用 `showNotification()`；
- 前台一条路、后台另一条路，两套弹通知的代码迟早会漂移（标题格式、tag、点击行为）。
  统一成一个入口，本地通知和推送通知长得一模一样。

---

#### ③ iOS 不给网页后台执行权，PWA 一走就被挂起、SSE 断开，本地通知在 iOS 上结构性无效

**✅ 结论正确。推理里有两处要修正。**

**修正一：Push 事件是唯一的例外。** 「不给后台执行权」是对的，WebKit 的表述很直白：

> Allowing websites to remotely wake up a device for silent background work is a privacy violation and expends energy.

出处：<https://webkit.org/blog/16535/meet-declarative-web-push/>

但**推送到达时系统会唤醒 Service Worker** 去跑 `push` handler——这正是 Web Push 能工作的
全部机制。代价是这次唤醒**必须**换来一条用户可见的通知（见第 ⑥ 条）。所以准确的说法是：
「iOS 不给网页**自发的**后台执行权，只给**被推送唤醒的**那一瞬间。」

**修正二：「结构性无效」要收窄。** 本地通知在 iOS PWA 上并非完全无效：
- PWA 在前台、用户在联系人页或别的会话 → SSE 活着，本地通知有效且应该弹；
- PWA 刚切到后台的短窗口内 → 大概率还活着；
- PWA 被系统挂起 / 用户划掉 → SSE 断，本地通知这条路彻底断。

所以准确说法是「**覆盖不到最重要的那一档**」。而那一档恰好占了绝大多数使用时间，
所以「必须上真正的 Web Push」这个结论完全成立。

**未确证**：iOS 具体多久把 PWA 挂起、SSE 在什么时机断。苹果没有公开任何数字，
也没有可引用的规范。**只能真机观察（TC-PWA-14）。**

---

#### ④ Apple 的 Web Push 走标准协议，VAPID 签名发到订阅给的 endpoint，不需要 Apple Developer 账号

**✅ 正确。** WebKit 官方博客原话：

> You do not need to be a member of the Apple Developer Program to use it.

出处：<https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/>

**但要补一个会直接踩到的坑，原判断没提**：Apple 的推送服务（`web.push.apple.com`）
对 VAPID JWT 的 `sub`（subject）声明校验**比别家严**——必须是真实域名的 `mailto:` 邮箱
或 `https://` URL。`mailto:someone@localhost` 这类会被直接 403 `BadJwtToken` 拒掉，
而 FCM / Mozilla 的推送服务是接受的。也就是说**在本地开发环境验通了，上生产打到苹果照样挂**。

出处：<https://github.com/openclaw/openclaw/issues/83134>（issue 标题即 "Auto-generated VAPID keys use @localhost subject, breaking Apple Web Push (iOS PWA)"）

RFC 8292 本身的硬要求：
- `exp` 声明**不得**超过请求时刻之后 24 小时；
- `aud` 声明必须是**推送 endpoint URL 的 origin**（不是我们自己的域名——每个 endpoint
  可能来自不同厂商，所以 JWT 得按 endpoint 分别签，不能签一次到处用）。

出处：<https://www.rfc-editor.org/rfc/rfc8292.html>

---

#### ⑤ payload 按 RFC 8291 用 `p256dh` + `auth` 加密，推送服务只转发密文，看不到正文

**✅ 正确，但措辞要更准，因为这关系到我们对用户怎么讲隐私。**

RFC 8291 的事实：
- 用户代理提供两样东西：一个 P-256 ECDH 公钥（订阅里的 `p256dh`）和一个 16 字节的
  认证密钥（`auth`）；
- 内容编码**只有一种**：`aes128gcm`（规范原话："The Content-Encoding header field
  therefore has exactly one value, which is `aes128gcm`."）；
- 加密的目的是防止推送服务对消息进行 "inspection, modification, and forgery"。

**但规范同时明说元数据挡不住**：

> the timing and length of communication cannot be hidden from the push service.
> While an outside observer might see individual messages intermixed with each other,
> the push service will see which application server is talking to which user agent.

出处：<https://www.rfc-editor.org/rfc/rfc8291.html>

**对我们的意义**：苹果看不到消息正文，但看得到「某台设备在什么时间收到了一条来自
`im.example.com` 的推送，长度多少」。所以推送里能不能放消息摘要，是个**产品决策**，
不是纯技术问题——见 §E 的未决问题 Q2。密文长度会泄露正文长度这一点，
可以用固定长度 padding 缓解（RFC 8291 支持），但我们**不做**（见 §D.8「不做的事」）。

---

#### ⑥ `userVisibleOnly: true` 是强制的，不能做静默推送

**⚠️ 原判断不准确：这是**两处**不同的强制，机制和后果都不一样，混成一句会导致设计出错。**

**订阅时的强制**（`PushManager.subscribe`）：

> **Note:** This parameter is required in some browsers like Chrome and Edge.
> They will reject the Promise if `userVisibleOnly` is not set to `true`.

出处：<https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe>

**运行时的强制**（WebKit，后果严重得多）：

> WebKit requires you as the developer to always show a notification; no silent push messages are allowed.
>
> if an event handler doesn't show the user visible notification for any reason **we revoke its push subscription**.

出处：<https://webkit.org/blog/16535/meet-declarative-web-push/>

**这一条是整个方案里约束力最强的一条，直接决定了架构：**

> Service Worker 的 `push` handler **收到就必须弹**，不能在里面做「要不要弹」的判断。
> 因为任何一条 `return` 而不弹的分支，代价都是**这台设备的订阅被永久吊销**——
> 用户下次得手动重开开关，而且他不会知道为什么。
>
> 所以「该不该弹」的全部判断必须在**服务端决定推不推**这一步做完。
> 这不是「为了省事放服务端」，是被平台规则逼出来的唯一正确切分。

具体做法：`push` handler 里 `event.waitUntil(showNotification(...))` 是**唯一出口**，
连 JSON 解析失败都要弹一条兜底的「你有一条新消息」。

---

#### ⑦ manifest 的 `display` 必须是 `standalone` 或 `fullscreen`

**✅ 正确。** WebKit 原话是 manifest

> with its `display` member set to `standalone` or `fullscreen`

出处：<https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/>

MDN BCD 的表述是等价的：「The app's manifest must have a non-default `display` value.」

**补充（未完全确证）**：iOS 历史上是靠 `<meta name="apple-mobile-web-app-capable" content="yes">`
进独立模式的，16.4 起 manifest 的 `display` 也算数。WebKit 那篇说开发者「有这个选项」
（have the option to）创建 manifest，暗示老 meta 仍然被认，但**没有明确说 16.4+ 上老 meta
依然有效**。两个都写不冲突、也没有代价，所以**两个都写**，真机验一次（TC-PWA-02）。

---

#### ⑧ iOS 主屏图标认 `apple-touch-icon`（180×180），**不认** manifest 里的 `icons`

**❌ 原判断有误。** WebKit 官方博客原话正好说明 manifest 的 icons **是被认的**：

> If you do both, `apple-touch-icon` will take precedence over the Manifest-declared icons.

出处：<https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/>

「两个都做的话 apple-touch-icon 优先」这句话的前提就是**只做 manifest 也能工作**。
正确说法是：**apple-touch-icon 优先级更高，不是唯一被认的**。

**180×180 这个尺寸**：苹果唯一写过 `apple-touch-icon` 标记的文档是 Safari Web Content Guide，
它现在已经进了苹果的归档库；其示例用的确实是 `sizes="180x180"`（60pt × 3x）。
我**没有找到现行的苹果官方文档**明写这个尺寸，二手来源高度一致但终究是二手。
标为「广泛采用，缺现行官方出处」。

出处（二手）：<https://realfavicongenerator.net/blog/apple-touch-icon-is-180x180-pixels-but-is-that-still-true>

**实践结论不变**：两套都提供。一张 180×180 的 `apple-touch-icon`，加上 manifest 里的
192/512 与一张 `purpose: "maskable"`（后者是给 Android 用的，iOS 不需要但也不会坏）。

---

#### ⑨ 加到主屏幕后是独立的存储沙箱，localStorage 里的 token 不共享，用户要重新登录一次

**✅ 正确，而且有 WebKit 工程师的明文确认——这是十条里出处最硬的一条。**

WebKit Bug 181849「"Add to homescreen" apps don't share storage with Safari」，
WebKit 的 Brent Fulgham 回复：

> The current behavior (on Apple platforms) is by design.
> Home Screen apps are created as isolated entities without shared state with the browser.

该 bug 状态至今为 `NEW`（未解决）。

出处：<https://bugs.webkit.org/show_bug.cgi?id=181849>

WebKit 关于 macOS Dock web app 的说法方向一致（"After a user adds a web app to the Dock,
no other website data is shared"），说明这是 Apple 平台上一以贯之的设计。

**对本项目的三个直接后果**（这几条要写进用户引导文案）：
1. 装到主屏之后**必须重新登录一次**，这是正常的，不是 bug；
2. `api.ts` 的 token 存储分两档（勾了「保持登录」写 `localStorage`，没勾写 `sessionStorage`）。
   在 PWA 里如果没勾，**每次从后台被系统回收后重开都要重登**——体验会非常糟。
   安装引导里要提示「装到主屏后登录时请勾上保持登录」；
3. 同一台 iPhone 上「Safari 标签页」和「主屏 App」会被我们当成**两台设备**看待
   （因为 deviceId 存在各自独立的存储里）。这**正是我们想要的**——见 §C。

---

#### ⑩ 欧盟地区 iOS 对主屏幕 Web App 有过反复（DMA 相关），现状如何

**现状：已经反转，主屏 Web App 在欧盟继续可用。对本项目无影响。**

时间线：
- 2024-02：iOS 17.4 beta 在欧盟把主屏 Web App 降级成「打开 Safari 的快捷方式」，
  苹果给的理由是 DMA 要求支持第三方浏览器引擎，会带来安全风险；
- 2024-03-01：苹果撤回。官方声明原话：
  > We have received requests to continue to offer support for home screen web apps in iOS,
  > therefore we will continue to offer the existing home screen web apps capability in the EU.
  >
  > Home Screen web apps continue to be built directly on WebKit and its security architecture.
- 2024-10（iOS 18.2）：欧盟进一步允许第三方浏览器引擎的 Web App。

出处：
- <https://9to5mac.com/2024/03/01/apple-home-screen-web-apps-ios-17-eu/>
- <https://www.macrumors.com/2024/03/01/apple-walks-back-decision-to-disable-eu-web-apps/>
- <https://www.macrumors.com/2024/10/24/ios-18-2-eu-third-party-browser-web-apps/>

**⚠️ 给后续 Agent 的一条排雷提醒**：检索这个话题时会搜到一批 2025/2026 的「PWA 指南」类
内容农场文章，其中有的直接写「Push notifications are not available in EU countries (iOS 17.4+)」。
**这与苹果 2024-03 的官方声明直接矛盾，判定为过时或错误，不要采信。**
这类页面 SEO 排名很高，是这次核查里最容易被带偏的地方。

---

### A.2 三条原判断里没有、但会直接影响设计的事实

这三条是核查过程中翻出来的，都会改变实现方式：

#### ⑪ iOS 不支持 `pushsubscriptionchange` 事件

MDN BCD：`ServiceWorkerGlobalScope.pushsubscriptionchange_event` 的 `safari_ios`
是 `version_added: false`（桌面 Safari 16 起支持）。

出处：<https://github.com/mdn/browser-compat-data/blob/main/api/ServiceWorkerGlobalScope.json>

**后果**：订阅失效（endpoint 轮换、系统清理）时，**我们收不到任何通知**，
只会表现为「推送忽然不到了」。所以：

> **每次 PWA 启动都要无条件重新 `subscribe()` 一次，并把结果 upsert 到服务端。**
> 不能「本地存过订阅就跳过」。`subscribe()` 对已有订阅是幂等的（返回同一个 endpoint），
> 代价只是一次本地调用 + 一次幂等的 upsert 请求。

#### ⑫ `notificationclick` / `clients.openWindow()` 在 iOS 上不可靠

MDN BCD 把 `notificationclick_event` 的 `safari_ios` 记成 `version_added: false`——
**这一条我判断是 BCD 过时或不准**：大量开发者报告点通知确实能打开 iOS 上的 PWA。
但同一批报告里也确实有两个真问题：
- `clients.openWindow()` 在 Safari / iOS 上「不做任何事也不报错」；
- 通知的自定义 `actions` 在 iOS 上不显示，只有系统默认的「查看」。

出处：
- <https://developer.apple.com/forums/thread/733538>（clients.openWindow Not Functioning）
- <https://developer.apple.com/forums/thread/768448>（notificationclick not triggered if PWA not opened）
- <https://developer.apple.com/forums/thread/726793>（Notification Actions on iOS 16.4）

**后果（写进 §D.3 的 SW 设计）**：`notificationclick` 里**优先** `clients.matchAll()`
找已存在的窗口并 `focus()` + `postMessage` 跳会话，`openWindow()` 只作为最后兜底；
**不要用 `actions`**。这一条**必须真机验证**（TC-PWA-12/13）。

#### ⑬ Badging API 在 iOS 16.4+ 可用

`navigator.setAppBadge()` / `clearAppBadge()` 能给主屏图标打未读数角标，
前台和 `push` handler 里都能调。

出处：<https://webkit.org/blog/14112/badging-for-home-screen-web-apps/>

**建议**：不进 PR1/PR2 的必做项，作为 PR2 的可选加分项（§D.3 有说明）。
我们已经有全站未读总数（`AppShell.tsx` 的 `totalUnread`），接上去成本很低。

---

### A.3 iOS 最低版本

| 能力 | 最低版本 | 出处 |
| --- | --- | --- |
| 主屏 Web App + Service Worker | iOS 11.3 | （早于本方案关心的范围，不细究） |
| `Notification` / `Push API` / `push` 事件 | **iOS / iPadOS 16.4** | MDN BCD、WebKit 16.4 博客 |
| Badging API（`setAppBadge`） | iOS / iPadOS 16.4 | WebKit Badging 博客 |
| Declarative Web Push | iOS / iPadOS 18.4 | <https://webkit.org/blog/16535/meet-declarative-web-push/> |

**本方案的最低要求：iOS / iPadOS 16.4**（2023-03 发布）。

低于 16.4 的设备：`Notification` 永远 undefined，`notifyPermission()` 落到
`'unsupported'` 一档，界面上明确说「需要 iOS 16.4 或更新版本」。**不做任何降级兜底**——
没有可用的替代机制。

**Declarative Web Push（18.4+）不采用。** 它能在不注册 SW 的情况下推通知，看起来更简单，
但（a）我们**无论如何都需要 SW**（前台本地通知也统一走 `showNotification`），
（b）它会把最低版本从 16.4 抬到 18.4，（c）它是新东西，跨端一致性没有标准 Web Push 好。
标准 Web Push 在 18.4+ 上照常工作。

### A.4 这个部署已经满足的 / 还要做的

| 前提 | 状态 | 说明 |
| --- | --- | --- |
| HTTPS | ✅ 已满足 | 用户已确认有反代 + HTTPS。SW 与 Push 都是 `[SecureContext]`，这是硬前提 |
| 公网可达 + 能访问苹果推送服务 | ✅ 已满足 | 服务端要能主动出站访问 `https://web.push.apple.com`。**注意方向是出站**，不是入站 |
| Service Worker 能被正确托管 | ⚠️ 要做 | `server/src/app.js` 的 `express.static` + SPA catch-all 有坑，见 §D.9 |
| manifest / 图标 | ❌ 没有 | `web/index.html` 现在只有 charset / viewport / title / 字体，一个 PWA 相关标签都没有 |
| Service Worker | ❌ 没有 | `web/` 下连 `public/` 目录都还没有 |
| 安全区适配 | ❌ 没有 | `styles.css` 全文没有一处 `env(safe-area-inset-*)`，`viewport` 也没有 `viewport-fit=cover` |
| VAPID 密钥 | ❌ 没有 | 要新增三个环境变量 + 一个生成脚本 |
| 反代对 `/sw.js` 的缓存策略 | ⚠️ 要写文档 | 现有 `deploy/README.md` 只写了 SSE 关缓冲和 100MB 请求体 |

---

## B. 分阶段与并行任务包

### B.0 为什么分两个 PR

PR1（PWA 外壳）**本身就有独立价值**，而且是 PR2 的硬前提：
不能装到主屏，推送连订阅都发起不了。更重要的是，PR1 涉及的全是「只有真机能验」的东西
（图标、启动画面、安全区、独立模式），把它和一套加密协议的实现混在一个 PR 里，
真机上出了问题根本分不清是哪一层。

**PR1 → 真机确认能装、布局不歪、SW 能 activated → 才开 PR2。**

### B.1 文件归属总表（并行的前提）

**同一个 PR 内，一个文件只属于一个任务包。** 跨 PR 的重复占用是允许的（顺序执行）。

| 文件 | PR1 归属 | PR2 归属 |
| --- | --- | --- |
| `web/index.html` | **1A** | — |
| `web/public/manifest.webmanifest` 🆕 | **1A** | — |
| `web/public/icons/*` 🆕 | **1A** | — |
| `web/public/apple-touch-icon.png` 🆕 | **1A** | — |
| `web/src/pwa-manifest.test.js` 🆕 | **1A** | — |
| `web/src/styles.css` | **1B** | — |
| `web/src/styles-integrity.test.js` | **1B** | — |
| `web/src/lib/notify.ts` | **1C** | **2D** |
| `web/src/modals/ProfileModal.tsx` | **1C** | **2D** |
| `web/src/notifications.test.tsx` | **1C** | **2D** |
| `web/src/lib/notify.install.test.ts` 🆕 | **1C** | — |
| `web/public/sw.js` 🆕 | **1D** | **2D** |
| `web/src/lib/sw.ts` 🆕 | **1D** | — |
| `web/src/lib/sw.test.ts` 🆕 | **1D** | — |
| `web/src/sw-source.test.js` 🆕 | **1D** | — |
| `web/src/main.tsx` | **1D** | — |
| `server/src/app.js` | **1E** | **2C**（`subscribe()` 要多传 deviceId） |
| `server/test/pwa-static.test.js` 🆕 | **1E** | — |
| `deploy/README.md` | **1E** | **2E** |
| `server/src/web-push.js` 🆕 | — | **2A** |
| `server/test/web-push-vectors.test.js` 🆕 | — | **2A** |
| `server/src/db.js` | — | **2B** |
| `server/src/push-store.js` 🆕 | — | **2B** |
| `server/src/routes/push.js` 🆕 | — | **2B** |
| `server/src/routes/users.js` | — | **2B** |
| `server/test/push-subscriptions.test.js` 🆕 | — | **2B** |
| `server/test/push-migration.test.js` 🆕 | — | **2B** |
| `server/src/events.js` | — | **2C** |
| `server/src/routes/conversations.js` | — | **2C** |
| `server/src/push-decide.js` 🆕 | — | **2C** |
| `server/test/push-decide.test.js` 🆕 | — | **2C** |
| `server/test/push-online.test.js` 🆕 | — | **2C** |
| `server/src/index.js` | — | **2E** |
| `server/src/vapid-config.js` 🆕 | — | **2E** |
| `server/test/vapid-config.test.js` 🆕 | — | **2E** |
| `scripts/generate-vapid-keys.mjs` 🆕 | — | **2E** |
| `deploy/.env.example` | — | **2E** |
| `web/src/lib/push.ts` 🆕 | — | **2D** |
| `web/src/lib/push.test.ts` 🆕 | — | **2D** |
| `web/src/lib/api.ts` | — | **2D** |
| `web/src/AppShell.tsx` | — | **2D** |
| `docs/测试用例.md` | 收尾统一改 | 收尾统一改 |

> **`docs/测试用例.md` 不分配给任何任务包。** 每个包都想往里加行，必冲突。
> 由 PR 的收尾提交统一把 §F 的用例并进去。

---

### PR1 — PWA 外壳（4+1 个并行任务包）

---

#### 任务包 1A — manifest、图标、index.html

**目标**：站点能被 iOS 识别为可安装的 Web App，装完图标正确、启动无地址栏。

**独占文件**
```
web/index.html
web/public/manifest.webmanifest      🆕
web/public/apple-touch-icon.png      🆕（180×180）
web/public/icons/icon-192.png        🆕
web/public/icons/icon-512.png        🆕
web/public/icons/icon-512-maskable.png 🆕
web/src/pwa-manifest.test.js         🆕
```

> `web/public/` 是 Vite 的静态目录，里面的文件会被**原样**拷进 `dist/` 根目录，
> 不参与打包、不加 hash。这正是 manifest 和 sw.js 需要的行为（路径必须稳定）。
> 开发模式下 Vite dev server 也从根路径提供它们，所以 `npm run dev` 下同样能测。

**要做的**

`web/public/manifest.webmanifest`：
```json
{
  "id": "/",
  "name": "Loop IM",
  "short_name": "Loop",
  "description": "团队内部聊天",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#F6F5F2",
  "theme_color": "#F6F5F2",
  "lang": "zh-CN",
  "dir": "ltr",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

字段说明（每一条都有原因，不是抄模板）：
- `display: "standalone"` —— **iOS 上 `Notification` 存不存在就取决于它**（见 A.1 ①⑦）。
  这不是外观选项，是功能开关。
- `id: "/"` —— iOS 16.4 起支持 manifest 的 `id`，它是 Web App 的稳定唯一标识。
  不给的话浏览器会拿 `start_url` 当 id，将来改 `start_url` 会被当成另一个 App。
  出处：<https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/>
- `scope: "/"` —— 和 SW 的 scope 对齐。
- `background_color` / `theme_color` 用 `styles.css` 里 `--bg` 的浅色值 `#F6F5F2`。
  **注意**：manifest 里只能写死一个颜色，深色主题下启动画面会闪一下浅色。
  这是 manifest 的固有限制，接受（记在 §E 已知妥协）。

`web/index.html` 的 `<head>` 里加：
```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="apple-mobile-web-app-title" content="Loop" />
<meta name="theme-color" content="#F6F5F2" />
```

- **`viewport-fit=cover` 是 1B 安全区适配的前提**：不加它，`env(safe-area-inset-*)`
  在 iOS 上恒为 0，1B 写的 CSS 一行都不生效。**这是 1A 与 1B 之间唯一的接口契约。**
- `apple-mobile-web-app-capable` 与 manifest 的 `display` 同时给（见 A.1 ⑦，老 meta
  是否仍必需未确证，两个都写零代价）。
- `apple-mobile-web-app-status-bar-style` 用 `default`：`black-translucent` 会让页面
  内容顶到状态栏底下，那要求布局完全靠安全区撑开，风险大。先用 `default`，
  真机看了不满意再说。

**图标**：从 `web/src/components/Logo.tsx` 的现有 SVG 导出 PNG。
apple-touch-icon **不能有透明背景**（iOS 会渲染成黑底），要填 `#F6F5F2`；
也不要自己做圆角，iOS 会裁。maskable 那张要留 20% 的安全边距。

**验收标准**
1. `npm run build --prefix web` 后，`web/dist/` 根目录有 `manifest.webmanifest`、
   `apple-touch-icon.png` 和 `icons/` 三张图；
2. 桌面 Chrome DevTools → Application → Manifest 无报错，图标全部加载；
3. 真机：iPhone Safari → 分享 → 添加到主屏幕 → 图标是 Loop 的 logo（不是网页截图），
   名字是「Loop」，点开**没有 Safari 地址栏和底部工具栏**。

**测试**：`web/src/pwa-manifest.test.js`
照 `styles-integrity.test.js` 的路子写——读文件、断言结构，**用 `.js` 不用 `.ts`**
（`tsconfig` 的 include 只覆盖 `src` 且没开 `allowJs`，写成 `.js` 就不用为 `node:fs`
去给 web 装 `@types/node`；vitest 照常收它）。至少锁住：
- manifest 能 `JSON.parse`；
- `display` ∈ `{standalone, fullscreen}`（**配一条注释说明为什么这条不能改**）；
- `id` / `start_url` / `scope` 都在；
- `icons` 至少含 192 和 512，且至少一个 `purpose` 含 `maskable`；
- `index.html` 含 `rel="manifest"`、`rel="apple-touch-icon"` 且 `sizes="180x180"`；
- `index.html` 的 viewport **含 `viewport-fit=cover`**（这条是给 1B 兜底的）。

---

#### 任务包 1B — 安全区适配

**目标**：iPhone 独立模式下，底部导航不被 Home 指示条盖住，顶部不被灵动岛/刘海挡住；
**桌面浏览器上像素级零变化**。

**独占文件**
```
web/src/styles.css
web/src/styles-integrity.test.js
```

**背景**：装到主屏进入独立模式后，页面会铺满整个屏幕（因为 1A 加了 `viewport-fit=cover`），
系统 UI 不再自动让路。`.tabbar` 现在是 `padding: 6px 4px 10px`，那 10px 会被
Home 指示条完全吃掉。

**要做的**（都是**只加不改**的追加式修改，与项目既有做法一致）：

1. `.app { height: 100%; }` → 补一条 `min-height: 100dvh;`。
   iOS 上 `100%` 会跟着地址栏收放跳动；`dvh` 是动态视口单位，独立模式下更稳。
   `100%` 那条**留着**当老浏览器的兜底（`dvh` 不认识就整条声明被忽略）。
2. `@media (max-width: 720px)` 里的 `.tabbar`：
   ```css
   padding: 6px 4px calc(10px + env(safe-area-inset-bottom, 0px));
   ```
   **`env()` 的第二个参数（兜底值）必须写**：非独立模式和桌面上 `env()` 返回 0，
   但在**不支持 `env()` 的环境**里整条 `calc()` 会失效，连原来的 10px 都没了。
3. `.chat__head`、`.convos` 的顶部内边距同理加 `env(safe-area-inset-top, 0px)`。
   **注意**：不能给 `.app` 直接加 top padding——`.app` 是 flex 容器，
   加了会把整个布局往下推，桌面上也跟着变。要加在具体的顶栏元素上。
4. `.toast` 在移动端的 `bottom: calc(62px + 63px + 10px)` 要跟着加安全区，
   否则提示条会贴到 Home 指示条上：
   ```css
   bottom: calc(62px + 63px + 10px + env(safe-area-inset-bottom, 0px));
   ```
5. 左右安全区（横屏 / 灵动岛横放）：给 `.app__body` 加
   `padding-left: env(safe-area-inset-left, 0px)` 和对应的 right。

**必须守住 `styles-integrity.test.js` 的三条规矩**（那道闸门是为一次真实事故加的）：
- 花括号必须平衡；
- 普通选择器不能嵌在别的块里（只有 `@media`/`@supports`/`@keyframes` 能有子块）；
- `.md .mdimg` / `.imgview` / `.attach-list` 必须留在顶层。

新加的规则**要么放在既有 `@media (max-width: 720px)` 块内部**，要么放在文件顶层，
**不要新开嵌套层级**。

**验收标准**
1. `npm test --prefix web` 全绿（含 styles-integrity 三条）；
2. 桌面 Chrome 上界面**逐像素不变**（`env()` 全返回 0，`calc` 结果与原值相同）；
3. 真机 iPhone（有 Home 指示条的机型）独立模式下：底部 tab 文字与指示条之间有明显间距，
   点击不误触；横屏时内容不被灵动岛切掉。

**测试**：给 `styles-integrity.test.js` 追加一条用例——
`.tabbar` 的规则体里必须出现 `safe-area-inset-bottom`。
理由写进注释：**这条 CSS 只在 iOS 独立模式下才有可见效果，任何自动化环境都验不出来，
所以只能用「这行字必须在」这种笨办法防止它被后来的合并冲突吃掉**——
和这个文件本来的存在理由是同一个。

---

#### 任务包 1C — 通知状态机加「需要先装到主屏幕」一档

**目标**：iOS Safari 上不再显示「当前浏览器不支持桌面通知」这句误导性的话，
改成告诉用户怎么装。

**独占文件**
```
web/src/lib/notify.ts
web/src/modals/ProfileModal.tsx
web/src/notifications.test.tsx
web/src/lib/notify.install.test.ts   🆕
```

**要做的**

`NotifyPermission` 加一档：
```ts
export type NotifyPermission =
  | 'insecure'       // 非安全上下文
  | 'needs-install'  // 🆕 iOS，还没添加到主屏幕
  | 'unsupported'    // 浏览器真的没有 Notification
  | 'default' | 'granted' | 'denied';
```

新增两个探测函数（都要能在 jsdom 下安全返回 false）：
```ts
/** 当前页面是不是运行在「已安装的 Web App」里。两条路都要认：
 *  - display-mode: standalone 媒体查询（标准，Android / 桌面 / iOS 16.4+ 都认）
 *  - navigator.standalone（iOS 的私有属性，老 iOS 只有它） */
export function isStandaloneDisplay(): boolean

/** 当前是不是 iOS / iPadOS 的 WebKit。
 *  ⚠️ iPadOS 13 起 Safari 默认报桌面 UA，UA 里没有 "iPad"，
 *  所以要补一条：Macintosh + maxTouchPoints > 1 就当成 iPad。 */
export function isIosWebKit(): boolean
```

`notifyPermission()` 的**判定顺序**（顺序本身就是需求，注释里要写死）：
```ts
export function notifyPermission(): NotifyPermission {
  if (notifyInsecureContext()) return 'insecure';
  // 'needs-install' 必须排在 'unsupported' 之前 ——
  // iOS Safari 标签页里 Notification 确实是 undefined，按老顺序会被判成
  // 「浏览器不支持」，而那句话是错的：用户换任何浏览器都一样（iOS 上全是 WebKit），
  // 真正该做的是「添加到主屏幕」。这就是这一档存在的全部理由。
  if (!notifySupported() && isIosWebKit() && !isStandaloneDisplay()) return 'needs-install';
  if (!notifySupported()) return 'unsupported';
  return Notification.permission as NotifyPermission;
}
```

`ProfileModal.tsx` 的 `notifyHint` 加一档文案（三件事都要说到）：
```
在 iPhone / iPad 上，网页通知只对「添加到主屏幕」之后的应用生效。
点屏幕下方的分享按钮 → 添加到主屏幕，再从主屏图标打开，这个开关就能用了。
注意：主屏应用有自己独立的登录状态，打开后需要重新登录一次，登录时记得勾上「保持登录」。
```
按钮在这一档**置灰**（和其余三档一致，避免引入新的交互模式），说明文字承担全部信息量。

**这一档不需要 iOS 版本判断**：低于 16.4 的设备装到主屏后 `Notification` 仍然 undefined，
会落到 `'unsupported'`，那时候「当前浏览器不支持」这句话就是**对的**了。
可以顺手把 `'unsupported'` 的文案补一句「iPhone / iPad 需要 iOS 16.4 或更新版本」。

**验收标准**
1. 模拟 iOS Safari 标签页（UA + 无 `Notification` + 非 standalone）→ 显示安装引导，
   不再显示「浏览器不支持」；
2. 模拟 iOS 独立模式 + 有 `Notification` → 走原来的 `default/granted/denied` 三档；
3. 桌面 Chrome / Firefox / 桌面 Safari → 行为**完全不变**；
4. jsdom（无 `Notification`、无 iOS UA）→ 仍然是 `'unsupported'`，
   `notifications.test.tsx` 现有 8 条用例全绿。

**测试**：`web/src/lib/notify.install.test.ts` 新建，覆盖上面四种环境的
`notifyPermission()` 返回值 + `isIosWebKit()` 对 iPadOS 桌面 UA 的识别。
`notifications.test.tsx` 里补一条：`needs-install` 时按钮 disabled 且提示里含「添加到主屏幕」。

---

#### 任务包 1D — Service Worker 空壳与注册

**目标**：装一个**什么都不做**的 Service Worker，把注册、部署、scope、缓存头这些坑
在还没有业务逻辑的时候先趟平。

**独占文件**
```
web/public/sw.js            🆕
web/src/lib/sw.ts           🆕
web/src/lib/sw.test.ts      🆕
web/src/sw-source.test.js   🆕
web/src/main.tsx
```

**为什么 PR1 就要有 SW**：
- iOS 上不注册 SW，PR2 连 `subscribe()` 都发起不了（`PushManager` 挂在
  `ServiceWorkerRegistration` 上）；
- SW 的部署问题（MIME 类型、scope、缓存）和推送逻辑的问题症状很像，
  混在一个 PR 里真机排查会非常痛苦。

**`web/public/sw.js`（PR1 版本，全文大约就这么长）**
```js
// Loop IM 的 Service Worker。
//
// ── 红线：这个文件里永远不许出现 fetch 事件监听 ──────────────────────
// 我们要 Service Worker，只是为了 Web Push（push + notificationclick）。
// 一旦加了 fetch handler，页面资源就会走 SW 的缓存策略，而这个项目刚吃过
// 「静默缓存导致用户看到旧界面、没有任何报错」的亏（见 styles-integrity.test.js
// 顶部那段事故说明，同一类问题）。没有 fetch handler = 所有请求原样走网络 =
// 缓存行为和没有 SW 时完全一致，风险为零。
// 离线可用不在本项目的目标里：这是个 IM，离线打开一个空壳没有意义。
//
// web/src/sw-source.test.js 会读这个文件的源码，断言里面没有 'fetch' 监听。
// 想加缓存请先删掉那条用例并说明理由 —— 那时你就得对着这段注释想清楚。

// 装上就立刻接管，不等所有旧页面关掉。
// 我们不缓存任何东西，所以「新旧 SW 并存」没有半点好处，只会让排查变复杂。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
```

**`web/src/lib/sw.ts`**
```ts
/** 注册 Service Worker。失败只 warn，绝不影响页面本身 ——
 *  没有 SW，网页照样是个能用的 IM，只是 iOS 上收不到推送。 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null>
```
要点：
- `if (!('serviceWorker' in navigator)) return null;`（jsdom、老浏览器）；
- `register('/sw.js', { scope: '/' })`；
- `catch` 里 `console.warn`，返回 `null`；
- 在 `main.tsx` 里调用，**放在 `createRoot().render()` 之后**——
  注册是异步的副作用，不该挡住首屏。

**验收标准**
1. `npm run build --prefix web` 后 `web/dist/sw.js` 存在且**内容与源文件逐字节相同**
   （`public/` 不参与打包，这一条顺手验证了这个前提）；
2. 桌面 Chrome DevTools → Application → Service Workers：显示 `activated and is running`，
   Source 是 `/sw.js`，scope 是 `/`；
3. Network 面板里页面资源**没有一条**显示 `(ServiceWorker)` 来源——证明没有 fetch handler；
4. 真机：装到主屏后，用 Mac 的 Safari「开发」菜单连上 iPhone，能看到 sw.js 已 activated。

**测试**
- `sw.test.ts`：mock `navigator.serviceWorker`，断言 `register` 被调用且参数正确；
  mock 成 reject，断言函数返回 `null` 且不抛。
- `sw-source.test.js`：读 `public/sw.js` 的文本，断言**不包含** `addEventListener('fetch'`
  和 `addEventListener("fetch"`。写成 `.js`（同 1A 的理由）。注释里说清这是道闸门。

---

#### 任务包 1E — 静态托管的 MIME、缓存与 SPA catch-all

**目标**：确保 `/sw.js` 和 `/manifest.webmanifest` 从生产服务端拿到的是**正确的东西**，
而不是被 SPA catch-all 兜成一张 HTML。

**独占文件**
```
server/src/app.js
server/test/pwa-static.test.js   🆕
deploy/README.md
```

**问题在哪**（`server/src/app.js:74-77`）：
```js
const dist = join(here, '..', '..', 'web', 'dist');
if (serveClient && existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api|\/uploads).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}
```

三件事要确认 / 修：

1. **MIME 类型（不用改代码，但要写测试锁住）**
   `.webmanifest` 在 `mime-db` 里映射到 `application/manifest+json`
   （已核实：`{"source":"iana","charset":"UTF-8","compressible":true,"extensions":["webmanifest"]}`），
   express 5 → `send` → `mime-types` 走的就是这张表，所以现成就是对的。
   但这依赖一条传递依赖的行为，**必须有测试守着**，不然哪天升级 express 就静默坏了。

2. **SPA catch-all 会掩盖真正的错误（要改）**
   构建产物缺失时（比如 CI 忘了跑 `npm run build`），`GET /sw.js` 会被
   `/^(?!\/api|\/uploads).*/` 兜住，返回 `200` + `index.html` + `Content-Type: text/html`。
   浏览器报的是「The script has an unsupported MIME type ('text/html')」——
   指向的是 MIME，真正的问题却是文件根本不存在。**把这两个路径加进排除列表**，
   让它们干净地 404：
   ```js
   app.get(/^(?!\/api|\/uploads|\/sw\.js|\/manifest\.webmanifest).*/, ...)
   ```
   注意 catch-all 排在 `express.static` **后面**，文件真的存在时 static 先命中，
   这个改动只影响「文件不存在」的情况。

3. **`/sw.js` 的缓存头（要改）**
   `express.static` 默认发 `Cache-Control: public, max-age=0`，浏览器每次都会回源验证，
   本身够用。但（a）中间还有一层反代/可能有 CDN，（b）浏览器对 SW 脚本的缓存上限是 24 小时，
   一个搞错的长缓存能让新 SW 一天都推不下去。显式钉死，别依赖默认值：
   ```js
   app.use(express.static(dist, {
     setHeaders: (res, filePath) => {
       // Service Worker 脚本永远不许被缓存住：它是所有后续更新的入口，
       // 一旦被中间层缓存，用户会卡在一个再也换不掉的旧版本上。
       if (filePath.endsWith('/sw.js')) res.setHeader('Cache-Control', 'no-cache');
     },
   }));
   ```
   **只对 `sw.js` 特判**，不动其余资源的缓存行为（Vite 产物带 hash，现状没问题）。

`deploy/README.md` 新增一小节「PWA 与 Service Worker」：
- HTTPS 是硬前提（SW 和 Push 都是 `[SecureContext]`）；
- 反代**不要**给 `/sw.js` 加长缓存（给出 Nginx / Caddy 各一行示例）；
- iOS 最低 16.4；
- 「添加到主屏幕」是独立存储沙箱，用户要重新登录一次（提前告诉运维，省一轮误报）。

**验收标准**
1. `npm test --prefix server` 全绿；
2. `curl -I https://<部署地址>/manifest.webmanifest` → `Content-Type: application/manifest+json`；
3. `curl -I https://<部署地址>/sw.js` → `Content-Type: application/javascript` 且
   `Cache-Control: no-cache`；
4. 把 `dist/sw.js` 临时删掉 → `curl -i /sw.js` 返回 **404**，不是 200 的 HTML。

**测试**：`server/test/pwa-static.test.js`，照 `server/test/helpers.js` 现有套路
起一个带 `serveClient: true` 的 app（要造一个临时 dist 目录）。至少四条：
manifest 的 Content-Type、sw.js 的 Cache-Control、sw.js 缺失时 404、
`/some/spa/route` 仍然返回 index.html（**防止改坏 SPA 路由**）。

---

### PR2 — Web Push（5 个并行任务包）

> **前置条件**：PR1 已合并，且已在真机上确认「能装、布局不歪、SW activated」。

---

#### 任务包 2A — 加密与协议层（纯函数，零新依赖）

**目标**：一个不碰数据库、不碰路由、不碰 Express 的模块，
输入订阅信息和明文，输出一次符合 RFC 8291 + RFC 8292 的 HTTP 请求。

**独占文件**
```
server/src/web-push.js                  🆕
server/test/web-push-vectors.test.js    🆕
```

**为什么不用 `web-push` npm 包**（这是一个判断，理由摆出来供推翻）：

| | 手写 | `web-push` 包 |
| --- | --- | --- |
| 新增依赖 | **0** | 1 直接 + `asn1.js` / `http_ece` / `https-proxy-agent` / `jws` / `minimist` |
| 最近发布 | — | **3.6.7，2024-01-16**（距今 2 年 7 个月） |
| 正确性怎么保证 | RFC 8291 §5 的**官方测试向量**逐字节对 | 靠上游 |
| 代码量 | 约 120 行 | 0 |

关键事实：**RFC 8291 §5 提供了完整的测试向量**——认证密钥、收发双方的私钥公钥、salt、
明文 `"When I grow up, I want to be a watermelon"`、推导出的 CEK 和 nonce、以及最终密文，
附录 A 还给了中间值。这意味着手写实现的正确性**可以被逐字节证明**，不是「看起来对」。

Node 22/24（CI 矩阵就是这两个）原生提供了全部需要的原语：
`crypto.createECDH('prime256v1')`、`crypto.hkdfSync`、`aes-128-gcm`、
以及签 VAPID JWT 用的 ES256（`jsonwebtoken` **已经是本项目的依赖**，
配合 `crypto.createPrivateKey({ key: jwk, format: 'jwk' })` 就能签）。

在一个只有 5 个直接依赖、每个决定都写清楚为什么的项目里，
为了 120 行有官方测试向量的代码引入 6 个包（其中一个是 `minimist`）不划算。

**⚠️ 但这是个有风险的判断，退路要写明**：如果 RFC 测试向量在**一天之内**没能跑通，
不要死磕，直接改用 `web-push` 包并在 PR 描述里说明。加密代码「差不多对」是最糟的状态——
它在本地能通、打到苹果就 400，而错误信息不会告诉你哪一步错了。

**接口契约**（其它任务包只认这三个导出，签名不许改）：
```js
/** RFC 8291 内容加密。返回可直接作为请求体的 Buffer。 */
export function encryptPayload({ p256dh, auth, plaintext }): Buffer

/** RFC 8292 的请求头。endpoint 决定 aud，所以每个 endpoint 要单独算。 */
export function vapidHeaders({ endpoint, subject, publicKey, privateKey }): Record<string,string>

/** 发一次推送。用全局 fetch，不引 http 客户端。
 *  返回 { ok, status, gone }；gone 为 true 表示 404/410 —— 调用方必须删掉这条订阅。 */
export async function sendPush({ subscription, payload, ttl = 86400 }): Promise<{ ok: boolean, status: number, gone: boolean }>
```

实现要点：
- HKDF 的三个 info 串一个字节都不能错：
  `"WebPush: info" || 0x00 || ua_public || as_public`、
  `"Content-Encoding: aes128gcm" || 0x00`、`"Content-Encoding: nonce" || 0x00`；
- 请求头：`Content-Encoding: aes128gcm`、`TTL`、`Urgency: normal`、
  `Authorization: vapid t=<jwt>, k=<base64url 公钥>`；
- **不记录任何正文**（`log.js` 顶部的红线），只记 endpoint 的 host、状态码、userId。

**验收标准**：`node --test server/test/web-push-vectors.test.js` 全绿，
且其中至少有一条是 RFC 8291 §5 的官方向量、一条是 RFC 8292 §2.4 的 JWT 例子。

**测试**：`web-push-vectors.test.js`
1. RFC 8291 §5 向量：固定 salt 和发送方私钥（要让 `encryptPayload` 支持注入，
   便于测试；生产路径走随机），断言输出密文与 RFC 逐字节相同；
2. RFC 8292 的 JWT：断言 header/payload 结构、`exp` 不超过 24 小时、
   `aud` 是 endpoint 的 origin；
3. `sendPush` 用 mock 的 `fetch`：404 和 410 都要 `gone: true`，
   429 / 500 要 `gone: false`；
4. 一条负向用例：`subject` 是 `mailto:x@localhost` 时**在本模块内就报错**
   （见 A.1 ④ 的 Apple 坑，与 2E 的启动自检双保险）。

---

#### 任务包 2B — 订阅存储、接口与账号联动

**目标**：把浏览器给的订阅存下来，并保证它在账号生命周期里不会变成安全漏洞。

**独占文件**
```
server/src/db.js                         （⚠️ 全 PR2 唯一有权改它的包）
server/src/push-store.js                 🆕
server/src/routes/push.js                🆕
server/src/routes/users.js
server/test/push-subscriptions.test.js   🆕
server/test/push-migration.test.js       🆕
```

**表结构**（走 `db.js` 的 `MIGRATIONS`，**第二个参数传 `null`** 那一档——
建表和建索引的 DDL 自带 `IF NOT EXISTS`，幂等由 DDL 自己保证，
不需要 `PRAGMA table_info` 判断，这是 `db.js:64-72` 那个循环里已经写明的约定）：

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  ua          TEXT,
  created_at  INTEGER NOT NULL,
  last_ok_at  INTEGER,
  fail_count  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subs_endpoint ON push_subscriptions(endpoint);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
```

字段说明：
- **`endpoint` 唯一索引是一条安全边界，不是去重优化。** 同一台设备换个人登录，
  浏览器给出的 endpoint 是同一个。如果按 `(user_id, endpoint)` 建唯一索引，
  库里会同时存在「甲的这个 endpoint」和「乙的这个 endpoint」两行，
  **甲会继续收到发给乙的消息摘要**。所以按 endpoint 唯一，upsert 时**覆盖 `user_id`**。
  这条必须有专门的测试用例。
- `device_id` 是 2C 判「这台设备在不在线」的键，见 §C。
- `ua` 只存 User-Agent 的前 120 字符，用来在设置界面里告诉用户「你在哪几台设备上开了通知」
  （本次不做界面，但字段先留着，回填不了的东西不要等要用时才加）。
- `fail_count`：连续失败计数，成功时清零。给运维排查用，不参与推送判定。
- **不加外键**：和 `messages.reply_to` 一个道理（`db.js:36`），
  账号删除的处理要显式做，不能靠 `ON DELETE` 悄悄发生。

**表不放进 `schema.sql`**：`CREATE TABLE IF NOT EXISTS` 对已经建好的库什么也不做，
新表放 `MIGRATIONS` 才能同时覆盖新库和老库——这是 `db.js:45-46` 那段注释已经踩过的坑。
（`attachment_refs` 是反例，它在 `schema.sql` 里，索引在 `MIGRATIONS` 里，
两处都要看才知道全貌；新表统一放 `MIGRATIONS`，别再制造第二个反例。）

**接口**（全部挂 `authenticate`）：

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/push/config` | — | `{ enabled: boolean, publicKey: string \| null }` |
| POST | `/api/push/subscribe` | `{ deviceId, subscription: { endpoint, keys: { p256dh, auth } } }` | `201 { ok: true }` |
| DELETE | `/api/push/subscribe` | `{ endpoint }` | `204` |

- `GET /api/push/config` 的 `enabled` 直接反映 2E 的 VAPID 自检结果。
  **不配 VAPID 时返回 `{ enabled: false, publicKey: null }`**，
  前端据此把开关显示成「服务端未启用推送」，而不是让用户点了之后一直失败。
- `POST` 的校验：`endpoint` 必须是 `https://` 且能 `new URL()`；
  `p256dh` / `auth` 必须是合法 base64url 且长度对（65 字节 / 16 字节解码后）。
  校验不过一律 `400`，**不要**存进去——一条格式错的订阅会让每次群发都多一次注定失败的请求。
- `DELETE` 只允许删**自己名下**的订阅（`WHERE endpoint = ? AND user_id = ?`），
  否则任何人都能用别人的 endpoint 把别人的推送关掉。

**`push-store.js` 的导出**（2C 只认这些）：
```js
export function upsertSubscription({ userId, deviceId, endpoint, p256dh, auth, ua })
export function subscriptionsFor(userIds)          // → [{ id, userId, deviceId, endpoint, p256dh, auth }]
export function deleteSubscription(endpoint)
export function deleteSubscriptionsForUser(userId)
export function markPushResult(endpoint, ok)       // 成功清零 fail_count + 写 last_ok_at
```

**账号联动（`routes/users.js`）**：停用账号时，`users.js:100` 已经调了 `disconnect(target.id)`
掐 SSE，**同一处要加 `deleteSubscriptionsForUser(target.id)`**。
理由写进注释：`disconnect` 挡住的是实时连接，推送订阅是**另一条完全独立的通道**，
不删的话被停用的人还会继续在锁屏上看到消息标题和摘要——**这是数据泄露，不是体验问题**。
改密码是否也要删？**不删**：改密码只作废 token，人还是他自己，
让他为此在每台设备上重开一次通知开关不合理。这个取舍要写在注释里。

**验收标准 / 测试**：`push-subscriptions.test.js` 至少覆盖
- upsert 幂等（同 endpoint 调两次只有一行）；
- **换人登录同一设备 → 只剩新用户那一行，旧用户查不到**（安全用例，必须有）；
- 非法 endpoint / 非法 key 长度 → 400 且不入库；
- 删别人的订阅 → 删不掉；
- 停用账号 → 该用户订阅清零。

`push-migration.test.js` 照 `reactions-migration.test.js` / `conversation-prefs-migration.test.js`
的既有写法：造一个没有这张表的老库，跑迁移，断言表和两个索引都在，且重复跑不报错。

---

#### 任务包 2C — 「该不该推」的判定与触发

**目标**：把 `shouldNotifyMessage` 那五条规则搬到服务端，并解决「用户此刻看不看得见」
这个服务端本来不知道的维度。设计细节见 **§C**，这里只写工程契约。

**独占文件**
```
server/src/events.js
server/src/routes/conversations.js
server/src/app.js                      （PR1 归 1E，PR1 合并后在 PR2 里归本包）
server/src/push-decide.js              🆕
server/test/push-decide.test.js        🆕
server/test/push-online.test.js        🆕
```

**`events.js` 的改动（尽量小）**：`clients` 从 `Map<userId, Set<res>>` 改成
`Map<userId, Map<res, deviceId>>`，`subscribe(userId, res, deviceId)` 多收一个参数
（缺省 `null`，老客户端不带也不能崩），新增导出：
```js
/** 这个人此刻有哪些设备连着 SSE。没有 deviceId 的连接不进这个集合。 */
export function onlineDeviceIds(userId): Set<string>
```
`emitTo` / `emitAll` / `disconnect` 的对外行为**一个字都不变**（迭代 `Map` 的 key 就是 res）。
`app.js:65` 那行 `subscribe(req.user.id, res)` 要改成把 `req.query.device` 一起传下去。
`app.js` 在 PR1 归 1E、在 PR2 归本包——两个 PR 顺序执行，不冲突。

**`push-decide.js`（纯函数，好测）**：
```js
/**
 * 这条消息要推给哪些订阅。
 * 全部输入都由调用方查好传进来 —— 这个函数不碰数据库，才能把每条规则单独锁住。
 */
export function targetsFor({
  message,        // { id, conversationId, senderId, kind }
  memberIds,      // 会话成员
  mutedBy,        // Set<userId>：把这个会话设成免打扰的人
  subscriptions,  // 这批人的全部订阅
  onlineDevices,  // Map<userId, Set<deviceId>>
}): Array<Subscription>
```

规则顺序与 `notify.ts` 的 `shouldNotifyMessage` **逐条对齐**（注释里要并排列出来，
将来改任何一边都要想到另一边）：
1. `message.kind === 'system'` → 一个都不推；
2. 跳过 `senderId`（自己发的）；
3. 跳过 `mutedBy` 里的人；
4. 跳过 `onlineDevices[userId]` 里的 `deviceId`（**这一条替代了前端的 `visible`**）；
5. 剩下的全推（有订阅 == 用户开了开关，替代前端的 `enabled`）。

**`conversations.js` 的接入点**：**只有两处**，都在 `emitTo(audience, 'message', ...)` 之后：
- `router.post('/:id/messages')` 里的 `emitTo(audience, 'message', { message })`（约 628 行）；
- `runAiTurn` 里 `safeEmit('message', { message: serializeMessage(row, ...) })`（约 567 行，Aria 的回复）。

`insertSystemMessage`（约 202 行）那处**不接**——它发的是 `kind: 'system'`，
规则 1 本来就会全部挡掉，不接省一次无谓的查询，也少一处将来会忘的调用点。

调用形态必须是**发射后不管**，和 `runAiTurn` 一个道理：
```js
// 推送不能拖慢发消息，也不能因为苹果的服务器抽风把这次请求带崩。
queuePush(message, audience).catch(reportPushFailure);
```
`queuePush` 内部自己兜住所有错误（对齐 `runAiTurn` 顶部那段注释讲的理由：
响应已经发出去了，之后冒出来的 rejection 会撞上 `ERR_HTTP_HEADERS_SENT`）。

**验收标准 / 测试**
- `push-decide.test.js`：五条规则各一条正向 + 一条反向；
  重点是**多设备矩阵**——同一个用户两台设备，一台 SSE 在线一台不在，只推不在线那台。
- `push-online.test.js`：起一个真的 app，建两条带不同 `?device=` 的 SSE 连接，
  断言 `onlineDeviceIds` 正确；断开其中一条，断言集合跟着变；
  不带 `device` 参数的老连接不进集合、也不报错。

---

#### 任务包 2D — 前端订阅、SW push handler、通知统一

**目标**：前端把订阅交给服务端，SW 收到推送就弹，并把本地通知也统一到 `showNotification`。

**独占文件**
```
web/public/sw.js                    （PR1 建的，这里接手扩写）
web/src/lib/push.ts                 🆕
web/src/lib/push.test.ts            🆕
web/src/lib/notify.ts
web/src/lib/api.ts
web/src/modals/ProfileModal.tsx
web/src/AppShell.tsx
web/src/notifications.test.tsx
```

**`sw.js` 加两个监听（`fetch` 仍然一个都没有，文件顶部那段红线注释保留）**：

```js
self.addEventListener('push', (event) => {
  // ⚠️ 这个 handler 的唯一出口就是 showNotification。
  // WebKit：「if an event handler doesn't show the user visible notification
  // for any reason we revoke its push subscription.」 —— 任何一条不弹的分支，
  // 代价都是这台设备的订阅被永久吊销，而用户完全不会知道发生了什么。
  // 所以连 JSON 解析失败都要弹一条兜底的。
  event.waitUntil((async () => {
    let d = null;
    try { d = event.data ? event.data.json() : null; } catch { /* 落到兜底 */ }
    await self.registration.showNotification(
      d?.title || 'Loop IM',
      {
        body: d?.body || '你有一条新消息',
        tag: d?.tag || 'loop-im:fallback',
        data: { conversationId: d?.conversationId || null },
        // ⚠️ 不要用 actions：iOS 上自定义 actions 不显示（只有系统的「查看」）。
      },
    );
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const id = event.notification.data?.conversationId;
    // 先找已经开着的窗口 focus —— clients.openWindow() 在 Safari / iOS 上有
    // 「不报错也不做事」的已知问题，能不用就不用。
    for (const c of all) {
      await c.focus();
      c.postMessage({ type: 'open-conversation', conversationId: id });
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(id ? `/?c=${id}` : '/');
  })());
});
```

**`push.ts`**：
```ts
/** 这台设备的稳定标识。存本地，丢了就换一个（只会导致多推一条，不会出错）。
 *  iOS 的主屏 App 有独立存储沙箱，所以它天然会拿到一个和 Safari 不同的 id ——
 *  这正是我们想要的：那确实是两个互不相干的通知目标。 */
export function deviceId(): string

/** 订阅并上报。每次应用启动都无条件调一次 ——
 *  iOS 不支持 pushsubscriptionchange 事件，订阅失效时我们收不到任何通知，
 *  只能靠每次启动重新 subscribe（对已有订阅是幂等的）来兜住。 */
export async function ensurePushSubscription(): Promise<boolean>

export async function unsubscribePush(): Promise<void>
```
要点：
- `subscribe({ userVisibleOnly: true, applicationServerKey })`，
  `applicationServerKey` 从 `GET /api/push/config` 拿，base64url → `Uint8Array`；
- `Notification.permission !== 'granted'` 时**不要**调 `subscribe`（会直接 reject）；
- 全程失败只 warn，不打断页面。

**`notify.ts`**：`notifyMessage` / `notifyEnabledConfirmation` 里的 `new Notification(...)`
换成「有 SW registration 就 `registration.showNotification(...)`，否则退回 `new Notification`」。
`shouldNotifyMessage` 那五条规则**一个字都不改**——服务端是它的镜像，
两边同时改才不会漂移，而这一版服务端已经照着它写了。

**`AppShell.tsx`**：加一个 `navigator.serviceWorker` 的 `message` 监听，
收到 `{ type: 'open-conversation' }` 就 `setTab('chat')` + `selectConversation(id)`——
和现有 `notifyMessage` 的 `onClick` 走同一条路径，复用即可。

**`ProfileModal.tsx`**：开关拨到「开」时，除了申请权限，再调 `ensurePushSubscription()`；
拨到「关」时调 `unsubscribePush()`。**开关的语义从「本地弹不弹」升级成「这台设备收不收通知」**，
提示文案要跟着改（说明关掉是「这台设备」，别的设备不受影响）。

**验收标准 / 测试**
- `push.test.ts`：mock `serviceWorker.ready` / `pushManager`，覆盖
  「没权限时不订阅」「订阅成功会 POST 上报」「服务端 `enabled:false` 时整条路径跳过」
  「subscribe 抛异常时返回 false 且不抛」；
- `notifications.test.tsx` 现有 8 条**全部要继续绿**（这是回归红线）；
  新增：有 SW 时走 `showNotification`、无 SW 时退回 `new Notification`。

---

#### 任务包 2E — VAPID 配置、启动自检、部署文档

**目标**：让运维能一条命令生成密钥；配错了在启动日志里一眼看出来，而不是等用户报「收不到」。

**独占文件**
```
server/src/index.js
server/src/vapid-config.js            🆕
server/test/vapid-config.test.js      🆕
scripts/generate-vapid-keys.mjs       🆕
deploy/.env.example
deploy/README.md
```

**三个环境变量**：
```bash
# ---- Web Push（iOS / Android 推送通知，默认关闭）----
# ⚠️ 不配这三项 = 推送整体关闭，服务照常启动，其它功能一切照旧。
#    生成：docker compose run --rm loop-im node scripts/generate-vapid-keys.mjs
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
# 必须是**真实域名**的 mailto: 或 https:// URL。
# ⚠️ 写成 mailto:xxx@localhost 会被苹果的推送服务用 403 BadJwtToken 拒掉 ——
#    本地测试全绿、上生产 iPhone 一条都收不到，是这块最容易踩的坑。
VAPID_SUBJECT=mailto:admin@example.com
```

**缺失时的处理，严格对齐 `UPLOAD_ORPHAN_SWEEP` 那一档**：
不配就是关闭，**绝不 `process.exit`**。附件存储那一档之所以配得上 `exit`
（`index.js:23-30`），是因为它是核心路径，半开状态比不启动更糟；
推送不是核心路径，聊天照常能用。启动时打**一行** `logWarn('push.disabled', { reason })`
说清为什么，不要每次推送时都打。

**配了但不合法**也走同一条路（关闭 + 一行 warn），并且要**说清哪一项不对**：
- 公钥/私钥不是合法的 base64url P-256 → `reason: 'invalid_key'`；
- `subject` 既不是 `mailto:` 也不是 `https://` → `reason: 'invalid_subject'`；
- `subject` 的域名是 `localhost` / `.local` / 纯 IP → `reason: 'subject_not_routable'`，
  日志里直接带上「Apple 会返回 403 BadJwtToken」这句话。

**`scripts/generate-vapid-keys.mjs`**：照 `scripts/` 现有脚本的风格
（中文说明、默认安全、可直接在容器里跑），输出三行能直接粘进 `.env` 的内容。
用 `crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })` + JWK 导出 + base64url。

**`deploy/README.md` 新增一节「推送通知（Web Push）」**，必须写到的四件事：
1. 三个变量怎么生成、怎么填；
2. **换 VAPID 公钥 = 所有已有订阅立即失效**。公钥是在浏览器 `subscribe()` 那一刻
   绑进订阅里的，换了之后老订阅推过去会被推送服务拒。换了必须通知所有用户
   在每台设备上重新打开一次通知开关。**这一条要加粗**——它是这块最容易造成
   「悄悄坏掉、几天后才有人报」的操作；
3. 服务端要能**出站**访问 `https://web.push.apple.com`（以及 Android 的
   `https://fcm.googleapis.com`）。有出站防火墙的环境要放行；
4. `docker compose logs loop-im | grep push.disabled` 一条命令判断推送是不是开着。

**验收标准 / 测试**：`vapid-config.test.js` 覆盖
「三个都不配 → disabled 且 reason 正确」「密钥格式错 → disabled」
「subject 是 localhost → disabled 且 reason 是 subject_not_routable」
「全部合法 → enabled」。

---

## C. 「该不该推」搬到服务端

### C.1 现状：五条规则里服务端知道四条

`notify.ts` 的 `shouldNotifyMessage`：

| # | 规则 | 服务端知道吗 |
| --- | --- | --- |
| 1 | `enabled`（用户开了开关） | ✅ 等价于「这个人有没有推送订阅」 |
| 2 | `!visible`（用户看不见这条消息） | ❌ **只有这一条不知道** |
| 3 | `senderId !== meId` | ✅ |
| 4 | `kind !== 'system'` | ✅ |
| 5 | `!conversation.muted` | ✅ `conversation_members.muted` |

### C.2 对「有活跃 SSE 连接就不推」的评估

**方向对，粒度错。按用户判会漏掉最常见的场景。**

反例（而且是日常最常见的一种）：用户在公司电脑上挂着 Loop IM 的网页（SSE 活着），
手机 PWA 关在口袋里。按用户判 → 「他在线」→ 一条推送都不发 → **手机永远静默**。
而「人不在电脑前」正是最需要手机响一下的时候。这个方案会让整次改造在最主要的场景下失效。

「iOS PWA 挂起时 SSE 正好会断，自动落在该推那一侧」这个观察本身是对的，
问题在于它只考虑了「用户只有一台设备」的情形。

### C.3 改进方案：按**设备**判，不按用户判

**核心机制**：
1. 每个客户端生成一个 `deviceId`（`crypto.randomUUID()`，存本地存储，
   key `loop-im-device`）。
2. SSE 建连时带上：`/api/stream?token=...&device=<deviceId>`
   （和 token 走查询串是同一个原因——`EventSource` 没法带自定义头）。
3. `events.js` 记住每条连接的 `deviceId`，导出 `onlineDeviceIds(userId): Set<string>`。
4. `push_subscriptions` 存 `device_id`。
5. **推送判定：跳过那些 `device_id` 在 `onlineDeviceIds(userId)` 里的订阅，其余全推。**

**为什么这个粒度是对的**：SSE 连接和推送订阅**本来就是同一台设备上的两条通道**。
一台设备的 SSE 活着，说明这台设备上的网页正在跑，它自己会用本地通知处理；
SSE 断了，说明这台设备上的网页没在跑，只有推送能触达它。
按设备判，两条通道**天然互补、不重不漏**。

**iOS 存储沙箱在这里是个意外的好事**（见 A.1 ⑨）：同一台 iPhone 上，
Safari 标签页和主屏 App 各有各的存储，因此各有各的 `deviceId`。
系统会把它们当成两台独立设备——**这正确**：用户开着 Safari 标签页时，
主屏 App 确实是关着的、确实需要推送。

### C.4 边界情况逐条

| 场景 | 行为 | 对不对 |
| --- | --- | --- |
| 桌面开着网页，手机 PWA 关着 | 只推手机 | ✅ 原方案办不到 |
| 手机 PWA 正开着（前台） | 该设备 SSE 在线 → 不推；本地通知负责 | ✅ |
| 手机 PWA 被系统挂起 | SSE 断 → 推 | ✅ 这是核心场景 |
| 群聊里 5 个人，3 个在线 | 每个人各算各的，只推 2 个 | ✅ |
| 同一人 3 台设备，2 台在线 | 只推第 3 台 | ✅ |
| 同一台 iPhone：Safari 标签开着 + PWA 关着 | 两个 deviceId → 照推 PWA | ✅ |
| 自己发的消息 | 规则 2 挡掉 | ✅ |
| 系统消息（入群/改群名） | 规则 1 挡掉 | ✅ |
| 免打扰会话 | 规则 3 挡掉 | ✅ |
| 用户被停用 | `disconnect()` + 删订阅（2B） | ✅ |
| 订阅已失效（endpoint 被回收） | 推送返回 404/410 → 立刻删行 | ✅ |

**竞态：SSE 刚断的那一瞬间**

- **判定原则：宁可多推一条，不可漏推。** 多一条通知是打扰，漏一条是功能失效。
- 断开方向：`res.on('close')` 里立刻从 Map 摘掉（现有代码 `events.js:18-23` 就是这样），
  **不做任何宽限期**。连接一没，下一条消息就推。
- 反方向有个**消不掉的窗口**：TCP 半开时（用户进电梯、拔网线），
  连接对象还在 Map 里，服务端以为在线，于是不推。心跳 25 秒一次
  （`events.js:17`），最坏情况会漏推约 25 秒内的消息。
  - 缩小它的办法：给每条连接记一个 `lastWriteOk`，`res.write()` 返回 false
    （内核缓冲区满）时就认为可疑。**但 `write()` 返回 true 也不代表对端收到了**——
    这个窗口在 TCP 层面就消不掉。
  - **本方案的选择：不做，接受这个窗口，写进已知限制。** 为一个最长 25 秒的窗口引入
    一套连接健康度状态机，复杂度和收益不成比例。真要缩，把心跳从 25s 降到 10s 更划算。

**被否决的两个备选**

1. **看 `conversation_reads` 判「他已经读到这儿了」**——不行。
   已读上报发生在用户**看到之后**，推送判定发生在消息**刚写库**的那一刻，
   此时 `last_read_at` 必然落后于这条消息。这个判据恒为「该推」，零信息量。
2. **延迟 N 秒再推，期间若上报了已读就取消**——能解决「用户其实正看着」的误推，
   但代价是**所有推送晚 N 秒**。IM 的消息晚 5 秒到就已经很难受了，
   而它换来的只是少几条本来也不算错的通知。不划算。

### C.5 服务端还需要注意的两件事

**推送内容里放什么**：`{ title, body, tag, conversationId }`。
`title` 和 `body` 直接复用现有函数的逻辑——`notifyTitle()`（群聊 `发送者 · 群名`，
单聊就是发送者）和 `previewOf()`（`conversations.js:120`，
已经把图片换成 `[图片]`、文件换成 `[文件] 名字`）。**两边输出必须一致**，
否则同一条消息在桌面和手机上长得不一样。见 §E 的 Q2（要不要放正文摘要）。

**日志**：`log.js` 顶部的红线——**消息正文永远不许进日志**。
推送只记 `{ userId, deviceId, conversationId, endpointHost, status }`，
不记 `title`、不记 `body`。注意 `redact()` 会拦 `body`/`preview`/`message` 这些键名，
但它是**兜底不是许可**，调用方自己要想清楚传了什么。

---

## D. 具体设计

### D.1 manifest 字段 / D.2 图标清单

见任务包 1A，不重复。

### D.3 `sw.js` 的职责边界

**我同意手写，不用 `vite-plugin-pwa`。理由（独立判断，不是附和）：**

1. **我们要的东西只有两个事件**：`push` 和 `notificationclick`，加起来不到 40 行。
   `vite-plugin-pwa` 的价值在 Workbox 的预缓存策略，那恰恰是我们**不要**的。
2. **这个项目刚吃过静默缓存的亏。** `styles-integrity.test.js` 顶部记的那次事故
   （一个丢掉的花括号让整批样式静默失效、九项 CI 全绿）说明这个项目对
   「不报错但行为不对」的问题特别敏感。Workbox 的预缓存正是这一类：
   资源版本对不上时，用户看到的是一个半新半旧的界面，没有任何报错。
3. **手写的 SW 不参与打包**（放 `web/public/`），生产上跑的就是仓库里那份源码，
   一个字不差。这和项目「每一处都写清楚为什么」的风格是一致的；
   生成的 SW 出了问题得先反编译才能看懂。
4. 少一个构建期依赖。

**但我要加一条比「手写」更重要的约束，这才是真正的安全属性：**

> **`sw.js` 里永远不许出现 `fetch` 事件监听。**
>
> 没有 `fetch` handler，浏览器就完全不走 SW 的网络路径，缓存行为与「没有 SW」
> 逐字节相同——静默缓存的风险从「靠人自觉」变成**结构上不可能**。
> 这条用 `web/src/sw-source.test.js` 写成闸门（任务包 1D）。

**代价，说清楚**：没有 `fetch` handler 就没有离线能力。对一个 IM 来说，
离线打开一个空壳没有意义，这个代价是零。

**另一个代价（要知道，但不影响我们）**：Chrome 的「可安装」判定历史上要求
SW 有 fetch handler（Chrome 后来对空 handler 做了忽略处理，判定标准也在演变）。
出处：<https://developer.chrome.com/blog/update-install-criteria>。
这只影响 Android/桌面 Chrome 会不会**自动**弹安装提示；
**iOS 的「添加到主屏幕」永远是用户手动操作，不受任何 installability 判定影响**，
而 iOS 就是这次改造的目标。

**SW 的完整职责清单（就这些，多一件都要先讨论）**：
- `install` → `skipWaiting()`
- `activate` → `clients.claim()`
- `push` → 解析 → `showNotification()`（唯一出口，含兜底）
- `notificationclick` → `matchAll` + `focus` + `postMessage`，兜底 `openWindow`
- **可选**：`push` 里顺手 `navigator.setAppBadge(n)`（推送 payload 带上未读总数）

**明确不做的**：`fetch`、`sync`、`periodicsync`、缓存 API、
`pushsubscriptionchange`（iOS 不支持，靠每次启动重新 subscribe 兜住，见 A.2 ⑪）。

### D.4 数据表

见任务包 2B。

### D.5 接口定义

见任务包 2B 的表格。补一条跨包契约：**推送 payload 的 JSON 结构**（2C 产出、2D 消费）：
```json
{
  "title": "陈子航 · 发版协作",
  "body": "明天的发版要不要提前？",
  "tag": "loop-im:c_abc123",
  "conversationId": "c_abc123",
  "badge": 7
}
```
`tag` 与前端 `notifyMessage` 用的 `loop-im:${conversationId}` **必须完全一致**——
这样同一个会话连来十条，本地通知和推送通知会互相覆盖，而不是堆成二十条。
`badge` 可选，给 D.3 的 Badging 用。

### D.6 环境变量

见任务包 2E。

### D.7 `notify.ts` 的新状态机

```
                    ┌─ isSecureContext === false ──────────────→ 'insecure'
                    │
notifyPermission() ─┼─ 没有 Notification + iOS WebKit + 非独立模式 ─→ 'needs-install'  🆕
                    │
                    ├─ 没有 Notification ───────────────────────→ 'unsupported'
                    │
                    └─ Notification.permission ─────────────────→ 'default' | 'granted' | 'denied'
```

每一档在 `ProfileModal` 里的表现：

| 档 | 按钮 | 说的话 |
| --- | --- | --- |
| `insecure` | 置灰 | 「当前不是 HTTPS…」（原样保留） |
| `needs-install` 🆕 | 置灰 | 「iPhone / iPad 上要先添加到主屏幕…装完需要重新登录一次…」 |
| `unsupported` | 置灰 | 「当前浏览器不支持。iPhone / iPad 需要 iOS 16.4 或更新版本。」（补一句） |
| `denied` | 置灰 | 原样保留 |
| `default` | 可点 | 原样保留 |
| `granted` + enabled | 可点 | 原样保留，但要改成说明这是**这台设备**的开关（PR2） |

**判定顺序不能动**，理由已写进 1C 的代码注释。

### D.8 服务端加密实现选型

见任务包 2A。补「不做的事」：
- **不做 payload padding**。RFC 8291 允许填充到固定长度以隐藏正文长度，
  但推送服务本来就看得到时间和收发方（见 A.1 ⑤），单独藏长度收益有限，
  而 padding 会让每条推送变大。真要防这一层，该做的是 Q2 那个决策（不放正文摘要）。
- **不做重试队列**。推送失败（除 404/410 删订阅外）只记日志，不重投。
  IM 的消息本身在 SSE 和数据库里都在，推送只是提醒；
  为一条晚到的提醒建一套持久化重试队列不划算。

### D.9 部署侧

见任务包 1E（静态托管）和 2E（配置与文档）。

---

## E. 风险与未决问题

### E.1 需要用户拍板的选择题

| # | 问题 | 选项 | 我的倾向 |
| --- | --- | --- | --- |
| **Q1** | **@我 要不要穿透免打扰？** 现在前端 `muted` 一票否决。很多 IM 允许 @ 穿透。 | (a) 保持一致，muted 全挡 (b) @我 穿透 muted | **(a)**。改了就得两边同时改，而 `conversations.js:47-49` 那段注释把 muted 的语义钉得很死（「不打扰，不是不计数」）。要改建议单独一个 PR。 |
| **Q2** | **推送里放不放消息摘要？** 放了锁屏上一眼能看到内容，但苹果的推送服务看得到密文长度，且**任何拿到手机的人都能在锁屏上读到**。 | (a) 放摘要（同桌面） (b) 只写「你有 1 条新消息」 (c) 做成服务端开关 | **(a)**，和桌面通知保持一致。这是内部 IM，用户对自己的手机锁屏有控制权。但这是**用户的隐私取舍，不是技术判断**，请明确拍一下。 |
| **Q3** | **Aria（AI）的回复要不要推？** 群里 @Aria 一次，她回一条，所有人都收到推送。 | (a) 照推 (b) 只推给触发她的那个人 (c) 完全不推 | **(b)**。群里 Aria 的回复对旁观者是噪音，对提问者是他等的东西。但这会让服务端规则和前端 `shouldNotifyMessage` 出现第一处不对称，需要在两边都写清楚。 |
| **Q4** | **`orientation: "portrait"` 锁竖屏？** iPad 上锁竖屏很怪。 | (a) 锁 portrait (b) 不写这个字段 | **(b) 不写**。iPad 是目标设备之一，横屏用得很多。 |
| **Q5** | **要不要做 Badging（主屏图标未读角标）？** | (a) PR2 一起做 (b) 单独 PR3 | **(a)**。我们已经有 `totalUnread`，payload 加个字段、SW 加一行 `setAppBadge`，成本极低，感知很强。 |

### E.2 只能真机验证的事（自动化一条都测不了）

1. **iOS 主屏 Web App 的页面上下文里 `new Notification()` 能不能用**（A.1 ②）。
   MDN BCD 说能，我没找到 WebKit 官方表述。不影响方案（我们统一走 `showNotification`），
   但值得测一下，因为如果 BCD 错了，说明 BCD 在这块整体不可信。
2. **`notificationclick` 在 iOS 上到底触不触发**（A.2 ⑫）。BCD 说不支持，
   社区报告说支持。**这一条直接决定「点通知能不能回到会话」这个核心体验。**
3. **`clients.openWindow()` 在 iOS 上可不可靠**（A.2 ⑫）。有多份苹果论坛报告说
   「不报错也不做事」。我们的设计已经优先走 `focus()`，但 App 完全没开时只能靠它。
4. **iOS 多久把 PWA 挂起、SSE 什么时候断**（A.1 ③）。没有任何公开数字。
   要测的是：PWA 切后台 10 秒 / 1 分钟 / 5 分钟 / 锁屏 30 分钟，各发一条消息，
   看是走 SSE 到的还是走推送到的。这决定了 §C 的判定在真实世界里准不准。
5. **设备重启后推送还到不到。** 有报告说 iOS PWA 在设备重启后推送会失效，
   直到用户手动打开一次 App。出处：<https://github.com/firebase/firebase-js-sdk/issues/8444>。
   如果属实，这是个**没有解法**的平台限制，只能写进文档告诉用户。
6. **`apple-mobile-web-app-capable` 在 16.4+ 上还认不认**（A.1 ⑦）。
7. **安全区在灵动岛机型 / 横屏下的实际效果**（1B）。
8. **存储沙箱导致的重新登录**（A.1 ⑨）。出处很硬（WebKit 工程师明文 + bug 至今未关），
   但那条评论是 2018 年的，值得花 30 秒复核一下。

### E.3 已知妥协（不打算解决，但要有人知道）

- **启动画面颜色**：manifest 只能写一个 `background_color`，深色主题下启动会闪一下浅色。
- **SSE 半开导致最长 25 秒漏推**（§C.4）。
- **推送不重试**（§D.8）。
- **已读之后不撤回已弹出的通知**。技术上可以（`getNotifications({tag})` + `close()`），
  但要 App 被唤醒才行，iOS 上做不到，做了也只在桌面生效——半边生效比不做更让人困惑。
- **没有「哪些设备开了通知」的管理界面**。`push_subscriptions.ua` 字段先留着，
  界面等有人要了再做。

---

## F. 真机验收清单

格式对齐 `docs/测试用例.md` §1。这些**全部 ✋ 只能人工**，自动化一条都覆盖不了。
合并进 `docs/测试用例.md` 时作为新的一节 **`S. PWA 与推送 `PWA``**，
并把 P0/P1 那几条加进 §5「只能人工验证的清单」。

### PR1 合并后必须过的（8 条）

| 编号 | 场景 | 步骤 | 期望 | 目的 | 自动化 |
| --- | --- | --- | --- | --- | --- |
| TC-PWA-01 | 能装到主屏幕 | iPhone Safari 打开站点 → 分享 → 添加到主屏幕 | 预览里显示 Loop 的图标和「Loop」这个名字，不是网页截图 | 装不上，后面一切都无从谈起 | ✋ 人工 |
| TC-PWA-02 | 独立模式 | 从主屏图标打开 | **没有** Safari 地址栏和底部工具栏，看起来像原生 App | `display: standalone` 生效是 iOS 上 `Notification` 存在的前提 | ✋ 人工 |
| TC-PWA-03 | 底部安全区 | 有 Home 指示条的 iPhone，独立模式，看底部 tab | tab 文字与指示条之间有明显间距；每个 tab 都点得到、不误触 | 不做安全区，底部导航会被系统 UI 吃掉一截 | ✋ 人工 |
| TC-PWA-04 | 顶部安全区 | 灵动岛机型，独立模式，进一个会话 | 顶栏的群名和返回按钮不被灵动岛遮住 | 同上，另一端 | ✋ 人工 |
| TC-PWA-05 | 横屏 | 独立模式下横过来 | 内容不被灵动岛/刘海切掉；竖回来布局正常复原 | 左右安全区容易被忘 | ✋ 人工 |
| TC-PWA-06 | 存储沙箱 | Safari 里已登录 → 从主屏图标打开 | **要求重新登录**（这是正确行为）；登录时勾「保持登录」，杀掉 App 再开仍在登录态 | 不提前说明，用户会当成 bug 报上来 | ✋ 人工 |
| TC-PWA-07 | SW 已激活 | Mac Safari「开发」菜单连上 iPhone → 检查主屏 App | 能看到 `/sw.js` 状态是 activated | PR2 的全部前提 | ✋ 人工 |
| TC-PWA-08 | 提示文案改对了 | iPhone **Safari 标签页**里打开个人资料 | 显示「先添加到主屏幕」的引导，**不再**显示「当前浏览器不支持桌面通知」 | 旧文案把 URL 的问题赖给浏览器，用户换浏览器也没用 | ✋ 人工 |

**顺带回归（桌面必须零变化）**

| 编号 | 场景 | 步骤 | 期望 | 目的 | 自动化 |
| --- | --- | --- | --- | --- | --- |
| TC-PWA-09 | 桌面无回归 | 桌面 Chrome 走一遍 §6 冒烟的 2~13 步 | 界面和行为与改造前**完全一致** | 安全区 CSS 和 SW 注册都可能误伤桌面 | ◐ 部分（e2e 覆盖行为，像素靠人看） |
| TC-PWA-10 | SW 不缓存任何东西 | 桌面 Chrome DevTools → Network | 没有任何一条请求的 Size 列显示 `(ServiceWorker)` | 这是 sw.js「不许有 fetch handler」那条红线的现场验证 | ✋ 人工（源码层有 `sw-source.test.js` 守着） |

### PR2 合并后必须过的（10 条）

| 编号 | 场景 | 步骤 | 期望 | 目的 | 自动化 |
| --- | --- | --- | --- | --- | --- |
| TC-PUSH-01 | 订阅成功 | 主屏 App 里打开个人资料 → 拨通知开关 | 系统弹一次权限框；同意后开关变「已开启」，立刻收到一条确认通知 | 通道到底通没通，用户需要一个当场的回执 | ✋ 人工 |
| TC-PUSH-02 | **应用关着也能收到** | 从主屏 App 上划退出（不是切后台）→ 锁屏 → B 发一条消息 | 锁屏上出现通知，标题「发送者 · 群名」，正文是摘要 | **这是整次改造的唯一目的** | ✋ 人工 |
| TC-PUSH-03 | 点通知回到会话 | 锁屏上点那条通知 | App 打开并**直接定位到那个会话** | 点了没反应等于没通知（TC-NOTIFY-06 的移动端版） | ✋ 人工 |
| TC-PUSH-04 | 前台不重复弹 | 主屏 App 开着并正看着这个会话 → B 发消息 | **不弹任何通知**，消息直接出现在列表里并标已读 | 眼前的消息再弹一次是纯打扰 | ✋ 人工 |
| TC-PUSH-05 | 前台在别的会话 | App 开着但停在联系人页 → B 发消息 | 弹一条（走本地通知），**只弹一条**不是两条 | 本地通知和推送同时到 = 重复打扰，`tag` 一致才能互相覆盖 | ✋ 人工 |
| TC-PUSH-06 | **桌面开着不挡手机** | 电脑上开着网页登录同一账号 → 手机 App 关掉 → C 发消息 | **手机照样收到推送** | §C 的核心：按设备判而不是按用户判，这一条是它存在的全部理由 | ✋ 人工 |
| TC-PUSH-07 | 免打扰不推 | 把某个群设为免打扰 → 关掉 App → 群里发消息 | 手机**不响**；同一时间另一个没设免打扰的会话来消息，照常响 | 免打扰必须真的挡住，两条通道都要挡 | ✋ 人工 |
| TC-PUSH-08 | 自己发的不推 | 电脑上发一条 → 看手机 | 手机不响 | 自己发的推给自己是很蠢的体验 | ✋ 人工 |
| TC-PUSH-09 | 系统消息不推 | 管理员把某人拉进群 | 群成员手机**不响**（消息还是会出现在列表里） | 群成员变动不值得打扰所有人 | ✋ 人工 |
| TC-PUSH-10 | 关开关就不推了 | 拨掉开关 → 关掉 App → 发消息 | 不响；重新拨开 → 又能响 | 关不掉的通知比没有通知更糟 | ✋ 人工 |

### 探索性验证（结论未知，做完把答案写回本文档 §E.2）

| 编号 | 要搞清楚的事 | 怎么测 | 为什么要测 |
| --- | --- | --- | --- |
| TC-PWA-11 | 主屏 App 页面里 `new Notification()` 到底能不能用 | Safari 远程调试的控制台里直接敲 `new Notification('x')` | MDN BCD 说能、MDN 正文说不能，两边打架 |
| TC-PWA-12 | `notificationclick` 在 iOS 上触不触发 | SW 里 `console.log` + 远程调试 | BCD 记的是「不支持」，但 TC-PUSH-03 依赖它 |
| TC-PWA-13 | `clients.openWindow()` 可不可靠 | App 完全没开时点通知 | 苹果论坛多份报告说它静默失效 |
| TC-PWA-14 | iOS 多久挂起 PWA / SSE 何时断 | 切后台 10s / 1min / 5min / 锁屏 30min 各发一条，看是 SSE 到的还是推送到的 | §C 的判定在真实世界里准不准，全看这个 |
| TC-PWA-15 | 设备重启后推送还到不到 | 重启 iPhone，**不打开 App**，发一条消息 | 有报告说会失效直到手动开一次 App。若属实是无解的平台限制，要写进文档 |
| TC-PWA-16 | 通知里的 `actions` | payload 带 actions | 预期：iOS 上不显示。确认后在代码注释里钉死「不要用 actions」 |

---

## 附录：出处清单

**WebKit / Apple 官方**
- Web Push for Web Apps on iOS and iPadOS — <https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/>
- WebKit Features in Safari 16.4 — <https://webkit.org/blog/13966/webkit-features-in-safari-16-4/>
- Meet Declarative Web Push — <https://webkit.org/blog/16535/meet-declarative-web-push/>
- Badging for Home Screen Web Apps — <https://webkit.org/blog/14112/badging-for-home-screen-web-apps/>
- WebKit Bug 181849（主屏 App 不与 Safari 共享存储，工程师确认为 by design）— <https://bugs.webkit.org/show_bug.cgi?id=181849>
- Apple 开发者论坛：clients.openWindow 失效 — <https://developer.apple.com/forums/thread/733538>
- Apple 开发者论坛：notificationclick 未触发 — <https://developer.apple.com/forums/thread/768448>
- Apple 开发者论坛：iOS 16.4 的通知 actions — <https://developer.apple.com/forums/thread/726793>

**规范 / RFC**
- Notifications API 规范（SW 作用域里构造函数抛 TypeError）— <https://notifications.spec.whatwg.org/>
- RFC 8291 Message Encryption for Web Push（含 §5 测试向量）— <https://www.rfc-editor.org/rfc/rfc8291.html>
- RFC 8292 VAPID — <https://www.rfc-editor.org/rfc/rfc8292.html>

**MDN / 兼容数据**
- Notification 构造函数 — <https://developer.mozilla.org/en-US/docs/Web/API/Notification/Notification>
- PushManager.subscribe（userVisibleOnly / applicationServerKey）— <https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe>
- BCD `api/Notification.json` — <https://github.com/mdn/browser-compat-data/blob/main/api/Notification.json>
- BCD `api/PushManager.json` — <https://github.com/mdn/browser-compat-data/blob/main/api/PushManager.json>
- BCD `api/ServiceWorkerGlobalScope.json`（pushsubscriptionchange / notificationclick 的 iOS 状态）— <https://github.com/mdn/browser-compat-data/blob/main/api/ServiceWorkerGlobalScope.json>
- caniuse: Notifications — <https://caniuse.com/notifications>

**欧盟 / DMA**
- iOS 17.4 不再移除欧盟的主屏 Web App — <https://9to5mac.com/2024/03/01/apple-home-screen-web-apps-ios-17-eu/>
- Apple 撤回决定（含官方声明原文）— <https://www.macrumors.com/2024/03/01/apple-walks-back-decision-to-disable-eu-web-apps/>
- iOS 18.2 允许第三方引擎的 Web App — <https://www.macrumors.com/2024/10/24/ios-18-2-eu-third-party-browser-web-apps/>

**其它**
- Apple 对 VAPID `sub` 的严格校验（`@localhost` 被 403 BadJwtToken）— <https://github.com/openclaw/openclaw/issues/83134>
- iOS PWA 设备重启后推送失效 — <https://github.com/firebase/firebase-js-sdk/issues/8444>
- Chrome installability 判定的演变 — <https://developer.chrome.com/blog/update-install-criteria>
- apple-touch-icon 180×180（二手，苹果原文已归档）— <https://realfavicongenerator.net/blog/apple-touch-icon-is-180x180-pixels-but-is-that-still-true>
