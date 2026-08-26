# Loop IM

一个「基础聊天 + 原生 AI 接入」的 IM 系统：React 前端 + Express/SQLite 后端。
界面按 Claude Design 原型 `project/聊天 IM 原型.dc.html` 实现（聊天布局采用 A 三栏版，AI 管理采用表格版）。

## 快速开始

```bash
# 1) 配置：仓库里不含任何账号与密钥，第一次运行需要自己填
cd server && cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # 填进 JWT_SECRET
# 再填 ADMIN_EMAIL / ADMIN_PASSWORD，这就是你的第一个管理员账号

# 2) 后端（首次启动自动建库、创建 Aria 与管理员）
npm install && npm start                     # http://localhost:4000

# 3) 前端（另开一个终端）
cd ../web && npm install && npm run dev      # http://localhost:5173
```

前端开发服务器把 `/api` 与 `/uploads` 代理到 `4000`。执行 `cd web && npm run build` 后，
后端会直接托管 `web/dist`，只跑 `cd server && npm start` 即可访问完整应用。

登录后用管理员身份在「联系人 → 添加联系人」里开通其他成员（系统会给出初始密码）。
想让本地一开始就有一批联系人，可以在 `.env` 里写：

```bash
DEMO_USERS=陈子航:chen@example.com:后端,周明:zhou@example.com:前端
DEMO_PASSWORD=只在本地用的密码
```

> `.env` 不会进 git。仓库里**没有**任何用户名、密码或密钥：管理员来自 `.env`，
> 联系人由管理员在界面上开通；`NODE_ENV=production` 时缺少 `JWT_SECRET` 会直接拒绝启动。

## 已实现的功能

**登录与身份**
- 邮箱 + 密码登录，密码在库里是 bcrypt 哈希加盐，token 有效期 15 天并保存在浏览器。
- 登录后右上角提示「已上线」；客户端每 45 秒心跳，联系人列表只显示在线/离线两种状态。

**联系人**
- 列出系统内全部成员，无需加好友，右侧「去聊天」直接开会话。
- 管理员额外可见「添加联系人」（开通新成员账号，返回初始密码）与「建群」；普通成员只能去聊天。
- 管理员可以**停用 / 恢复**成员账号（员工离职）。停用**不是删除**：该成员所有设备上的登录
  立刻失效（含已建立的 SSE 长连接），无法再登录、发消息，也不出现在建群 / 加成员的可选名单里；
  但他发过的消息、群成员身份、头像和名字照常显示，随时可以恢复。不能停用自己，也不能停用 Aria。

**未读与已读**
- 会话列表显示未读条数，侧栏与底部标签栏的「会话」上显示总未读（超过 99 显示 `99+`）。
- 真实已读回执：打开会话、窗口重新聚焦时上报已读位置，自己的气泡随之从「已发送」
  变为「已读」（私聊）或「n 人已读」（群聊）。只依据对方真实上报的位置，不拿在线状态推断。

**群管理**
- 建群者与系统管理员可以添加 / 移除成员、修改群名；任何成员都能自己退群。
- 群主不能被别人移除；Aria 可以被移出群，移出后新消息不再对 AI 可见，也可以再加回来。
- 成员变动与改群名会在聊天里留下一行居中的系统提示。

**聊天**
- 左右气泡布局，消息以 Markdown 存储与渲染（段落、列表、加粗、行内代码、链接、图片、@提及）。
- 历史消息按游标分页，默认加载最新 50 条，顶部「加载更早的消息」或上滑继续往前翻。
- 输入框默认单行、与回形针按钮等高；回形针从本地选**任意文件**，也支持直接粘贴图片或文件。
- 附件按用途分三档，服务端按**真实字节**判定，不看客户端自报的类型和文件名（见下节）：
  图片（PNG/JPEG/GIF/WebP，上限 8MB）拼成 Markdown 图片内联显示；视频（MP4/WebM，
  上限 100MB）用浏览器原生 `<video>` 内联播放，回源支持 Range（206），能拖进度条；
  PDF/ZIP/DOCX 等普通文件（上限 8MB）拼成链接，渲染成「文件卡片 + 下载」，永远不内联。
- 输入 `@` 弹出提及气泡，支持 ↑↓ 选择、Enter/Tab 确认、Esc 关闭。
- 群聊右栏显示成员、在线状态与「AI 掌握的上下文」摘要。
- 新消息、AI 输入中、在线状态通过 SSE (`/api/stream`) 实时推送。

**消息互动**
- 表情回应：气泡上用白名单内的 emoji 回应，同一个人对同一条消息同种表情只算一次，实时同步。
- 引用回复：任意消息可引用后回复，气泡带原文摘要，点引用块跳回原消息。
- 消息搜索：按关键词搜自己可见的消息，权限隔离（搜不到自己不在的会话），游标翻页。
- 会话可置顶、可免打扰：只影响自己那一份列表；免打扰的会话不弹通知、徽标弱化。

**通知与推送（PWA）**
- 桌面通知：在个人资料里手动开启（不进门就弹权限框）。切走时来消息才弹，正看着的会话不弹，
  免打扰的不弹；点通知聚焦窗口并直接回到那个会话。
- 可安装：手机上「添加到主屏幕」后以独立窗口运行，带自己的图标、启动画面与刘海/指示条安全区适配。
- 真离线推送：iOS（16.4+ 主屏 App）与 Android 走标准 Web Push（VAPID 签名 + RFC 8291 端到端加密，
  推送服务只见密文）。应用完全关掉也能收到，点通知回到对应会话。「该不该推」按**设备**判定：
  电脑开着网页不影响手机收推送；自己发的、免打扰的、群成员变动这类系统提示不推。
- 应用图标角标（Badging）显示未读总数（支持的平台上）。
- 方案、真机验收清单与已知平台限制全部记录在 [docs/PWA-与推送改造方案.md](docs/PWA-与推送改造方案.md)。

**防滥用**
- 登录失败、发消息、@AI、上传、建群分档限流；@Aria 单独更严一档（每次都真实计费）。
  触发时提示里写明几点几分可以再试，限流日志一个窗口只记一条且不含正文。

**原生 AI（Aria）**
- 群聊里静默读取全部上下文；被 `@Aria` 时必定回复，`@全员` 是否触发可在配置里开关。
- 成员可与 AI 一对一私聊（可由管理员关闭）。
- 持续为每个人积累「沟通偏好与习惯」画像，并在下一次回复时作为提示注入。
- 供应商可切换：OpenAI、xAI Grok、Codex（本地 Agent）。**未配置凭据时自动退回本地模拟回复**，
  所以整套流程离线也能跑通；配置了 API Key 就走真实调用。

**AI 管理（管理员）**
- 页面顶部显示当前状态（供应商是否连接、群聊静默读取开关）。
- 统计只保留「今日被 @ 次数」与「关键信息点」。
- 列表是 Aria 正在跟踪的对话对象；点击进入二级页，先看 AI 推导出的偏好/习惯与关键信息点，
  再点「查看详细 · 原始对话」展开原始聊天记录。
- 右上角「AI 配置」进入二级页：选择 Agent、填凭据、三个行为开关、测试连通性。

**个人资料**
- 侧栏底部头像进入弹窗：改昵称、上传头像（走同一套对象存储）、改密码、切换浅色/深色、退出登录。

**响应式**
- 桌面 64px 图标侧栏（含选中态）；≤720px 切换为底部标签栏，会话列表与聊天页互相切换。
- 浅色 / 深色两套主题，跟随系统并可手动切换后记忆。

## 附件的安全策略（issue #22）

上传目录 `/uploads` 和聊天系统**同源**，所以「这份文件会不会被浏览器当网页执行」是一道
安全边界，不是格式偏好问题。规则全部收在 `server/src/attachments.js`：

| | 判定 | 落盘 | 回源响应头 | 前端 |
| --- | --- | --- | --- | --- |
| 图片 | magic number 嗅探，只认 PNG / JPEG / GIF / WebP | 扩展名**由嗅探结果决定** | `image/*` + `nosniff` | 内联 `<img>` |
| 视频 | 同一套嗅探，只认 MP4（`ftyp` + major brand 白名单）/ WebM（EBML + DocType `webm`） | 扩展名**由嗅探结果决定** | `video/*` + `nosniff` + `Accept-Ranges: bytes`，支持 206 / 416 | 内联 `<video>` |
| 普通文件 | 其余任意内容照收 | 一律 `<uuid>.bin` | `application/octet-stream` + `Content-Disposition: attachment` + `nosniff` + `CSP: default-src 'none'` | 文件卡片 + 下载，永不内联 |
| SVG | 开头 1KB 出现 `<svg` 即命中 | 拒收（400） | — | — |

要点：

- 客户端自报的 `Content-Type` 和文件名都**不参与安全判定**。声称是图片/视频却拿不出对应
  字节的一律 400（不会悄悄降级成附件）；原始文件名只作为**显示名**存库和进消息，绝不参与
  磁盘路径与 URL。
- 视频能内联，安全模型和图片完全一致：只有嗅探通过的才进这一档，MP4 / WebM 都不是可导航
  可执行的类型，配 `nosniff` + 精确 `video/*` 之后，一份伪装成 `.mp4` 的 HTML 只会是个
  放不出来的坏视频。
- 头像只走图片这一档 —— 它一定会被渲染成 `<img>`，上限仍然是 8MB。
- 回源响应头按扩展名白名单发，白名单之外一律强制下载，所以**修复之前**遗留在磁盘上的
  `.html` / `.svg` 从升级那一刻起也已经跑不起来了。
- 对象可以存进 MinIO，但**浏览器永远不直连对象存储**：上面这组头全部是 Express 回源时加的，
  让浏览器直连（预签名 URL、公开桶、CDN）会把它们一并丢掉，存储型 XSS 当场复活。
  所以 MinIO 只在 Docker 内网监听，回源走 `server/src/routes/upload-files.js` 这个代理，
  安全策略仍然只有 `attachments.js` 一处。详见 `deploy/README.md`。
- 附件下载要鉴权：只有**该附件所在会话的成员**能下载（未登录 401，非成员和查无此附件
  给逐字相同的 404，不做存在性探针）。头像是全员可见的，单独一档。归属关系记在
  `attachment_refs` 表里，升级时会扫历史消息正文自动回填。

附件的清理一律**不默认发生**：内置的孤儿对象清理默认关闭（`UPLOAD_ORPHAN_SWEEP`），
历史文件的清点/清理也是**手动**的，不在启动时自动删用户数据：

```bash
node scripts/cleanup-legacy-uploads.mjs                  # 只清点，什么都不改（默认）
node scripts/cleanup-legacy-uploads.mjs --apply          # 移进 uploads/quarantine/，可恢复
node scripts/cleanup-legacy-uploads.mjs --apply --delete # 直接删除，不可恢复
```

回归用例：`server/test/issue-22.test.js`（真实字节样本见 `server/test/samples.js`）、
`web/src/lib/md.test.ts`、`web/src/components/Composer.file.test.tsx`。

## 部署（Docker）

镜像由 GitHub Actions 构建推送到 `ghcr.io/cherrylover/loop-im`，服务器上只需要
`deploy/` 里的 `docker-compose.yml` + `deploy.sh` + 自己填的 `.env`：

```bash
ssh user@your-server '/opt/loop-im/deploy.sh'       # 更新到最新版
ssh user@your-server '/opt/loop-im/deploy.sh v1.2.0'
```

`deploy.sh` 会拉镜像、停旧起新、轮询健康检查，失败时打印日志并提示回滚。
SQLite 库与图片附件都挂在与 compose 文件同级的 `data/` 目录，备份即打包该目录。
详见 [`deploy/README.md`](deploy/README.md)。

本地也可以直接构建运行：

```bash
docker build -t loop-im .
docker run -d -p 4000:4000 \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD=your-password \
  -v "$PWD/data:/app/data" loop-im
```

## 变更记录

- [12 个 issue 的修复报告](docs/issue-fixes-2026-08.md)（2026-08）：逐条根因、修法、回归用例，
  以及升级注意事项与仍未覆盖的三项。
- [PWA 与推送改造](docs/PWA-与推送改造方案.md)（2026-08）：可安装 + iOS/Android 真离线推送，
  分 PR1（外壳）/ PR2（Web Push）两步落地，真机验收清单与已知平台限制都在方案里。
- 主题「跟随系统」修复（2026-08-26）：旧版首次加载会把系统颜色当成手动选择存下来，
  之后系统切深浅色应用不再跟随；现在没手动选过就实时跟随，手动切换过才记忆。

## 测试与 CI

```bash
npm run test          # 后端 940 条 + 前端 905 条（约 1 分钟）
npm run test:server   # node:test，跑在临时 SQLite 库上，不碰 server/data
npm run test:web      # vitest（jsdom + testing-library）
npm run test:e2e      # 构建前端后用 Playwright 跑 13 条真实浏览器冒烟
npm run test:deployed # 对跑起来的部署再跑 22 条真实浏览器验证（要传测试账号，见 e2e/deployed/）
```

覆盖范围（2026-08-26 实测数字，用例总账见 [docs/测试用例.md](docs/测试用例.md)）：

| 层次 | 用例 | 覆盖内容 |
| --- | --- | --- |
| 后端 `server/test` | 940（58 文件） | 登录 / 权限 / 限流 / 会话与群管理 / 消息与 @ 机制 / 已读回执 / 表情回应 / 引用回复 / 搜索 / 附件安全（嗅探、鉴权、Range）/ 对象存储 / Web Push（加密、订阅、该不该推）/ AI 全流程 / 安全默认值与日志脱敏 |
| 前端 `web/src/**/*.test.*` | 905（75 文件） | Markdown 渲染与 XSS 转义 / 乐观发送与合并排序 / 输入框与 @ 提及 / 通知状态机 / 推送订阅与 sw.js 源码约束 / 主题跟随系统与手动记忆 / 各组件交互 |
| 端到端 `e2e` | 13 | 登录 → 建群 → @Aria 全链路、移动端布局与跳转、Toast 不挡按钮、深色主题、主题跟随系统 |
| 部署后 `e2e/deployed` | 22 | 对真实部署跑：附件、已读回执、搜索、表情回应、个人资料、AI 管理二级页 |

GitHub Actions（`.github/workflows/ci.yml`）在每次 push 与 PR 上跑三个 job：
后端测试（Node 22 与 24）、前端类型检查 + 单元测试 + 构建、以及依赖前两者的 Playwright 冒烟。
端到端失败时会上传 trace 作为 artifact。

## 目录结构

```
server/                Express + node:sqlite 后端
  src/schema.sql        表结构（users / conversations / messages / attachments / ai_settings / ai_profiles）
  src/bootstrap.js      账号初始化：系统 AI + .env 里的管理员与本地联系人
  src/auth.js           bcrypt + JWT（15 天）、在线判定
  src/ai.js             供应商调用、@ 解析、回复策略、画像学习
  src/attachments.js    附件类型判定（magic number 嗅探）与 /uploads 回源响应头策略
  src/range.js          Range 请求头解析（视频 206 / 416）
  src/upload-temp.js    上传中转文件的读取与清理（成功 / 失败 / 断线 / 启动兜底）
  src/storage.js        附件存储（默认本地磁盘，配了 S3_BUCKET 就走 MinIO；切换期双读）
  src/object-store.js   对象存储的可替换接口：local / s3 / memory（测试用内存实现）
  src/s3-sign.js        AWS SigV4 签名（只够 PUT/GET/DELETE 单个对象，不引第三方 SDK）
  src/attachment-access.js  附件下载鉴权（按会话成员判定）与孤儿对象定期清理
  src/events.js         SSE 推送
  src/push-decide.js    「该不该推」的五条规则（按设备判定，与前端 notify 逻辑对齐）
  src/push-store.js     推送订阅的存取（含设备可见性状态）
  src/web-push.js       Web Push 协议：VAPID 签名 + RFC 8291 payload 加密（不引第三方 SDK）
  src/routes/           auth / users / conversations / uploads / upload-files / ai / push / search
web/                   Vite + React + TypeScript 前端
  public/               PWA 外壳：manifest.webmanifest、图标、sw.js（只做推送，永不缓存页面）
  src/styles.css        设计 token（浅色/深色）与全部组件样式
  src/lib/              api 客户端、Markdown 渲染、时间格式、主题、通知与推送、SSE hook
  src/pages/            登录、聊天、联系人、AI 管理
  src/modals/           建群、添加联系人、个人资料
docs/                  方案与测试文档：PWA 与推送改造方案、测试用例集、issue 修复报告
deploy/                部署：docker-compose.yml、deploy.sh、.env.example
Dockerfile             多阶段构建：构建前端 → 装后端生产依赖 → 单镜像同时托管 API 与静态文件
project/               原始设计原型（Claude Design 导出）
chats/                 设计过程的对话记录
```

## API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | 邮箱密码登录，返回 15 天 token |
| GET | `/api/auth/me` | 当前用户 + AI 公共信息 |
| POST | `/api/auth/ping` | 心跳（维持在线状态），返回全员在线状态 |
| POST | `/api/auth/logout` | 主动退出：结束本会话，该账号无其他设备在线时立刻广播离线 |
| PATCH | `/api/auth/me` | 改昵称 |
| POST | `/api/auth/me/avatar` | 上传头像 |
| POST | `/api/auth/me/password` | 改密码 |
| GET | `/api/users` | 全部成员 |
| POST | `/api/users` | 管理员开通新成员 |
| POST | `/api/users/:id/disable` | 管理员停用账号（所有设备立刻失效，聊天记录保留） |
| POST | `/api/users/:id/enable` | 管理员恢复账号 |
| POST | `/api/users/:id/reset-password` | 管理员重置成员密码，返回新的初始密码 |
| GET | `/api/conversations` | 我的会话列表 |
| POST | `/api/conversations/group` | 管理员建群（至少 1 人，AI 默认加入） |
| POST | `/api/conversations/direct` | 打开/创建一对一（含 AI 私聊） |
| PATCH | `/api/conversations/:id` | 改群名（群主 / 管理员） |
| POST/DELETE | `/api/conversations/:id/members` | 添加 / 移除群成员（群主 / 管理员） |
| POST | `/api/conversations/:id/leave` | 退出群聊 |
| GET/POST | `/api/conversations/:id/messages` | 读取（游标分页）/ 发送消息 |
| POST | `/api/conversations/:id/read` | 上报已读位置 |
| PATCH | `/api/conversations/:id/prefs` | 置顶 / 免打扰（个人设置，只改自己那一份） |
| POST/DELETE | `/api/conversations/:id/messages/:messageId/reactions` | 加 / 取消表情回应 |
| GET | `/api/messages/search` | 搜索自己可见的消息（关键词 + 游标翻页） |
| GET | `/api/conversations/:id/ai-context` | 群内 AI 上下文摘要 |
| POST | `/api/uploads` | 附件上传（图片 / 视频按真实字节嗅探，其余作为只能下载的文件）。返回 `kind` 为 `image` / `video` / `file` |
| GET | `/api/stream` | SSE：新消息 / AI 输入中 / 在线状态 / 已读回执 |
| GET | `/api/push/config` | Web Push 公钥与开关状态 |
| POST/DELETE | `/api/push/subscribe` | 注册 / 注销本设备的推送订阅 |
| POST | `/api/push/visibility` | 上报本设备是否在前台（服务端按设备决定该不该推） |
| GET/PUT | `/api/ai/settings` | AI 配置（管理员） |
| POST | `/api/ai/test` | 测试连通性（管理员） |
| GET | `/api/ai/overview` | AI 管理列表与统计（管理员） |
| GET | `/api/ai/profiles/:userId` | 某个人的画像与原始对话（管理员） |

## 配置项

见 `server/.env.example`。

| 变量 | 说明 |
| --- | --- |
| `PORT` | 服务端口，默认 4000 |
| `JWT_SECRET` | 签发登录 token 的密钥。**生产环境必填**，缺失时服务拒绝启动 |
| `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 首个管理员账号，只在该邮箱不存在时创建 |
| `DEMO_USERS` / `DEMO_PASSWORD` | 本地开发用的联系人（`姓名:邮箱:部门`，逗号分隔），留空则不创建 |
| `AI_NAME` | AI 成员显示名，默认 `Aria` |
| `ENCRYPTION_KEY` | 加密落库的密钥（目前用于 AI 供应商的 API Key）。留空则 Key 仍以明文存库 |
| `CORS_ORIGIN` | 跨域白名单，逗号分隔。默认同源部署不需要填；留空时生产环境不发跨域头 |
| `TRUST_PROXY` | 部署在反向代理后面时填，否则按 IP 限流会把所有请求算成反代的 IP |
| `LOGIN_WINDOW_MS` / `LOGIN_MAX_FAILURES` | 登录失败限流的窗口与上限，默认 15 分钟 10 次 |
| `RATE_MESSAGE_WINDOW_MS` / `RATE_MESSAGE_MAX` | 发消息限流，默认 1 分钟 60 条（按用户，数成功次数） |
| `RATE_AI_WINDOW_MS` / `RATE_AI_MAX` | @Aria 限流，默认 5 分钟 10 次。这一档单独且更严：每次都真实调用大模型 |
| `RATE_UPLOAD_WINDOW_MS` / `RATE_UPLOAD_MAX` | 上传限流（聊天附件与头像共用），默认 1 分钟 20 次 |
| `RATE_WRITE_WINDOW_MS` / `RATE_WRITE_MAX` | 建群 / 加成员等写接口限流，默认 1 分钟 30 次 |
| `S3_BUCKET` / `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_REGION` | 配置后附件走 MinIO / S3 兼容存储，留空用本地磁盘。切换步骤见 `deploy/README.md` |
| `UPLOADS_LOCAL_FALLBACK` | 切换期双读：对象存储里没有的附件回落到本地磁盘。老文件搬完后设 `0` 关掉 |
| `UPLOADS_LEGACY_ACCESS` | 历史附件（库里查不到归属的老对象）的降级策略：`authenticated`（默认）/ `deny` |
| `UPLOAD_ORPHAN_SWEEP` | 孤儿对象清理的总开关，**默认关闭**（程序不主动删用户数据）。设 `on` 才启用 |
| `UPLOAD_ORPHAN_TTL_HOURS` / `UPLOAD_SWEEP_INTERVAL_MINUTES` | 上面开了才有意义：保留时长与扫描间隔，默认 24 小时 / 60 分钟 |
| `CODEX_ENDPOINT` | Codex 本地 Agent 的调用地址（可选） |

AI 供应商与 API Key 存在数据库里，通过「AI 配置」页面维护，接口不会把 Key 回传给前端。

## 与原型的差异

- 去掉了原型顶部的演示切换条（主题/视口/身份/布局）：主题切换移到个人资料弹窗，身份由登录账号的角色决定，
  视口交给响应式断点，聊天布局固定为 A 三栏、AI 管理固定为表格版。
- 图标统一改用 [lucide-react](https://lucide.dev)（品牌 Logo 仍为自绘气泡标志）。
- 精简了偏技术的说明文案（如「哈希加盐」「已归档至 SQLite」），只保留用户关心的信息。
- 登录页不再预填账号密码。

---

## 原始交付说明（Claude Design handoff）

（以下为交付包原文，保留备查。）

This is a **handoff bundle** from Claude Design (claude.ai/design).

A user mocked up designs in HTML/CSS/JS using an AI design tool, then exported this bundle so a coding agent can implement the designs for real.

## What you should do — IMPORTANT

**Read the chat transcripts first.** There are 1 chat transcript(s) in `chats/`. The transcripts show the full back-and-forth between the user and the design assistant — they tell you **what the user actually wants** and **where they landed** after iterating. Don't skip them. The final HTML files are the output, but the chat is where the intent lives.

**Read `project/聊天 IM 原型.dc.html` in full.** The user had this file open when they triggered the handoff, so it's almost certainly the primary design they want built. Read it top to bottom — don't skim. Then **follow its imports**: open every file it pulls in (shared components, CSS, scripts) so you understand how the pieces fit together before you start implementing.

**If anything is ambiguous, ask the user to confirm before you start implementing.** It's much cheaper to clarify scope up front than to build the wrong thing.

## About the design files

The design medium is **HTML/CSS/JS** — these are prototypes, not production code. Your job is to **recreate them pixel-perfectly** in whatever technology makes sense for the target codebase (React, Vue, native, whatever fits). Match the visual output; don't copy the prototype's internal structure unless it happens to fit.

**Don't render these files in a browser or take screenshots unless the user asks you to.** Everything you need — dimensions, colors, layout rules — is spelled out in the source. Read the HTML and CSS directly; a screenshot won't tell you anything they don't.

## Bundle contents

- `README.md` — this file
- `chats/` — conversation transcripts (read these!)
- `project/` — the `React聊天系统设计规划` project files (HTML prototypes, assets, components)
