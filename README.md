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

**聊天**
- 左右气泡布局，消息以 Markdown 存储与渲染（段落、列表、加粗、行内代码、链接、图片、@提及）。
- 输入框默认单行、与「+」按钮等高；「+」从本地选图，也支持直接粘贴图片。
- 图片按附件流程走：先上传到对象存储拿到链接，再拼成 Markdown 图片随消息发出。
- 输入 `@` 弹出提及气泡，支持 ↑↓ 选择、Enter/Tab 确认、Esc 关闭。
- 群聊右栏显示成员、在线状态与「AI 掌握的上下文」摘要。
- 新消息、AI 输入中、在线状态通过 SSE (`/api/stream`) 实时推送。

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

## 测试与 CI

```bash
npm run test          # 后端 56 个接口用例 + 前端 28 个单元用例
npm run test:server   # node:test，跑在临时 SQLite 库上，不碰 server/data
npm run test:web      # vitest（jsdom + testing-library）
npm run test:e2e      # 构建前端后用 Playwright 跑真实浏览器冒烟
```

覆盖范围：

| 层次 | 用例 | 覆盖内容 |
| --- | --- | --- |
| 后端 `server/test` | 56 | 登录与 token、密码哈希、角色权限（成员拿不到管理接口）、会话可见性与成员排序、建群 2–3 人校验、Markdown 消息收发、@Aria 必回 / 未被 @ 静默 / @全员 跟随开关、AI 私聊开关、未配置凭据时降级、AI 配置不回传 API Key、画像与统计、图片上传与非图片拒绝、安全默认值（缺 `JWT_SECRET` 拒绝启动、没配管理员就不造账号、日志不打印密码） |
| 前端 `web/src/**/*.test.*` | 28 | Markdown 渲染与 XSS 转义（`javascript:` 链接、属性注入）、时间格式、消息合并排序与乐观发送去重、输入框 Enter/Shift+Enter、@ 提及气泡的 ↑↓ 选择与过滤 |
| 端到端 `e2e` | 4 | 登录 → 群聊 @Aria 拿到回复；联系人 / 建群 / AI 管理二级页 / AI 配置；普通成员无管理入口且能私聊 AI；深色主题与移动端布局 |

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
  src/storage.js        附件存储（默认本地磁盘，S3 driver 留了接入点）
  src/events.js         SSE 推送
  src/routes/           auth / users / conversations / uploads / ai
web/                   Vite + React + TypeScript 前端
  src/styles.css        设计 token（浅色/深色）与全部组件样式
  src/lib/              api 客户端、Markdown 渲染、时间格式、主题、SSE hook
  src/pages/            登录、聊天、联系人、AI 管理
  src/modals/           建群、添加联系人、个人资料
project/               原始设计原型（Claude Design 导出）
chats/                 设计过程的对话记录
```

## API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | 邮箱密码登录，返回 15 天 token |
| GET | `/api/auth/me` | 当前用户 + AI 公共信息 |
| POST | `/api/auth/ping` | 心跳（维持在线状态），返回全员在线状态 |
| PATCH | `/api/auth/me` | 改昵称 |
| POST | `/api/auth/me/avatar` | 上传头像 |
| POST | `/api/auth/me/password` | 改密码 |
| GET | `/api/users` | 全部成员 |
| POST | `/api/users` | 管理员开通新成员 |
| GET | `/api/conversations` | 我的会话列表 |
| POST | `/api/conversations/group` | 管理员建群（2–3 人，AI 默认加入） |
| POST | `/api/conversations/direct` | 打开/创建一对一（含 AI 私聊） |
| GET/POST | `/api/conversations/:id/messages` | 读取/发送消息 |
| GET | `/api/conversations/:id/ai-context` | 群内 AI 上下文摘要 |
| POST | `/api/uploads` | 图片附件上传 |
| GET | `/api/stream` | SSE：新消息 / AI 输入中 / 在线状态 |
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
| `S3_BUCKET` / `S3_REGION` | 配置后附件走 S3（需在 `src/storage.js` 的 s3 分支接入客户端），留空用本地磁盘 |
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
