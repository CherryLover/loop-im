# 12 个 issue 修复报告

合并提交：[`7aeeafa`](https://github.com/CherryLover/loop-im/commit/7aeeafa7464a1fa7f432ba705399518a4ffc4180) · 12 个 issue 并行修复后统一合入 `main`

回归结果：后端 **80** 个用例、前端 **63** 个、端到端 **12** 条，本地连续三次全绿；
CI（Node 22/24 + 前端 + e2e）与 Docker（构建 + 推送 + 容器冒烟）均通过。
镜像已发布到 `ghcr.io/cherrylover/loop-im:latest`。

## 逐条结果

| # | 问题 | 根因 | 修法 | 回归用例 |
| --- | --- | --- | --- | --- |
| 1 | 关闭「群聊静默读取上下文」后 AI 仍学习普通群消息 | 每条消息无条件调 `learnAbout()`，开关只影响回复不影响学习；消息没有可见性记录，改开关会追溯生效 | 写库时按会话类型 + AI 是否在群 + 开关 + @ 规则定档 `messages.ai_visible`；画像学习、回复上下文、原始对话查询都只读可见消息 | `server/test/issue-1.test.js` |
| 2 | 修改密码后旧登录凭据仍可用 | token 只有 id/角色/过期时间，没有可撤销的版本标记 | 新增 `users.auth_version`，改密码时 +1 让旧 token 全部作废，当前设备换发新凭据 | `server/test/issue-2.test.js` |
| 3 | 取消「保持登录」仍会长期保持登录 | 复选框只是装饰，前端始终写 localStorage、后端始终签 15 天 | 不勾选时前端写 sessionStorage、后端只签 1 天；勾选与否走同一套换发逻辑 | `server/test/issue-3.test.js`、`web/src/lib/issue-3.test.ts` |
| 4 | 手机端从联系人「去聊天」后没有进入目标聊天 | 列表/详情的开合状态在 `ChatPage` 内部，切 tab 重新挂载即丢失 | 状态提升到 `AppShell`，「去聊天」「建群」统一走 `selectConversation` | `e2e/issue-4.spec.ts` |
| 5 | 手机端建群成功后没有直接进入新群 | 同上，建群时 `ChatPage` 重新挂载，停在会话列表 | 与 #4 合并为同一机制 | `e2e/issue-5.spec.ts`、`web/src/issue-5.test.tsx` |
| 6 | 主动退出后其他成员仍看到其在线 | 退出只清本地 token，服务端没有 logout，在线与否只看 90 秒心跳窗口 | 新增 `sessions` 表与 `POST /api/auth/logout`：结束会话、该账号无其他设备在线时立刻置离线并广播 | `server/test/issue-6.test.js`、`web/src/issue-6.test.tsx` |
| 7 | 发给离线成员的消息立即显示「已读」 | 界面把「已读」写死在自己的气泡里，数据层根本没有已读概念 | 改为「已发送」，并加接口用例约束不得返回伪造的已读字段 | `server/test/issue-7.test.js`、`web/src/issue-7.test.tsx` |
| 8 | 测试连通性后保存 AI 配置，仍显示旧测试结果 | 保存成功与测试结果是两个互不清理的状态 | 合并成单一 feedback 状态，切换供应商/改凭据/改开关都会清掉过期反馈 | `web/src/pages/issue-8.test.tsx` |
| 9 | 图片超过 8MB 时显示英文错误，且未提示大小上限 | multer 的 `File too large` 被兜底处理成 500 原样返回，前端也没有本地校验 | 统一 413 + 中文文案，前后端共用同一常量，选图/粘贴/头像三处上传前本地拦截，界面标注上限 | `server/test/issue-9.test.js`、`web/src/issue-9.test.tsx` |
| 10 | AI 配置的三个规则开关没有可识别名称 | 开关按钮只有装饰用空 span 与 `aria-pressed`，名称是旁边的纯文本 | 改为 `role="switch"` + `aria-checked`，用 `aria-labelledby`/`aria-describedby` 关联名称与说明 | `web/src/pages/issue-10.test.tsx` |
| 11 | 手机端登录提示遮挡「建群」按钮并截获点击 | Toast 固定右上角且接收指针事件，390 宽下正好压住按钮 | Toast 不再吃点击（`pointer-events: none`），移动端移到底部安全区域，限制最大宽度 | `e2e/issue-11.spec.ts` |
| 12 | E2E 测试不能稳定重复运行 | 复用固定数据目录且不清理，第二次跑撞上上一轮的数据；端口固定；用例间有依赖 | 每次运行独占临时数据目录与空闲端口，跑完清理；用例数据带时间戳，互不依赖 | 全套 e2e 连续三次通过 |

## 合并阶段处理的问题

- `server/src/db.js` / `auth.js`：#1、#2、#6 各自加了迁移与 token 字段，合成一张迁移表与统一的
  `signToken(user, { remember, sessionId })`（版本号、会话、有效期三种语义共存）。
- #4 与 #5 是语义冲突：两边各实现了一套手机端跳转机制，统一为受控状态 + `selectConversation`。
- 跨 issue 打断的测试：#9 新增导出让 #5 的 mock 失效、#10 改了开关语义让 #8 的断言失效，均已修正。
- 两条老 e2e 是按修复前的行为写的（手机端停在列表），改为验证修复后的正确行为。
- **review 发现一个合并引入的缺陷**：#2 让改密码换发 token，但换发走了 `setToken` 默认的
  `remember=true`，会把 #3 的「仅本次会话」凭据升级成长期保存。已修并补两个回归用例。

## 升级注意

- **本次升级后所有人需要重新登录一次**：`auth_version` 校验会让升级前签发的 token 全部失效，
  这是 #2 修复的必然结果，只发生一次。
- 数据库自动迁移：新增 `messages.ai_visible`、`users.auth_version` 与 `sessions` 表，老数据保留。
- 部署：`ssh user@your-server '/opt/loop-im/deploy.sh'`

## 仍未覆盖的三项（建议单独开 issue）

1. **真正的已读回执**（#7 的延伸）：现在只到「已发送」。要做需要成员已读位置、上报接口、
   SSE 事件与前端上报，是一轮独立功能开发。
2. **历史画像清洗**（#1 的延伸）：`ai_visible` 只对新消息生效，开关关闭前已写入画像的内容仍在，
   需要一个管理端「重置/重建画像」入口。
3. **同浏览器多标签会话**（#6 的延伸）：多个标签共享同一 token 即同一会话，一个标签退出会让
   其他标签一起失效。要互不影响需改为每标签独立签发。
