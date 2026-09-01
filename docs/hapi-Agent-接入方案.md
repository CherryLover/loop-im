# hapi Agent 接入方案（只加文档，不动代码）

> Loop IM 不再自己养 AI：接入自托管的 [hapi](https://github.com/tiann/hapi)，
> 把 hapi 里的 AI Agent（Claude Code / Codex / Grok 等）映射成系统里的 **AI 用户**，
> 大家在聊天里 @ 它们干活。现有的 Aria（供应商直连 + 画像那一套）**整体退役**。

最后更新：2026-08-31 · 状态：**全部完成并已上线**——线上跑在 Sophie 那套 hapi 上（Codex + Grok-Build），冒烟通过

---

## 0. 一句话定位

**Loop IM 是 hapi 的聊天前端。** 我们不运行 AI、不保管 AI 的记忆、不管理 AI 的生命周期——
这些全在 hapi 侧。我们只做三件事：把消息递过去、把回复贴回来、把「哪些 Agent 可用」映射成
「哪些 AI 用户存在」。

```
IM 用户 ──@ Claude-Code──▶ Loop IM 服务端 ──HTTP API──▶ hapi hub ──▶ runner ──▶ Claude Code 进程
                              ▲                                                      │
                              └───────────── SSE 收到回复，贴回聊天 ◀────────────────┘
```

---

## A. 已拍板的决定（2026-08-28）

这些是讨论后定下来的，实施时不要再摇摆；要改先改这份文档。

| # | 决定 | 内容 |
| --- | --- | --- |
| D1 | **一个 Agent = 一个 AI 用户** | hapi 某台机器上每个可用的 Agent，在 Loop IM 里对应一个 `role='ai'` 的用户 |
| D2 | **机器支持的全部自动接入**（2026-08-31 升级） | 机器上可用的 Agent **自动**创建/启用用户，不用逐个勾选；管理员仍可手动关掉（尊重且不强行拉回）、也可手动打开探测漏网的。可用性来源见 D2' |
| D2' | **可用性探测三档**（`HAPI_AGENTS`） | `auto`（默认）：按本机 PATH 探测各家 CLI 命令——前提是 Loop IM 与 runner 同机同环境（本地开发即是）；显式清单（线上容器里探测不到宿主机，部署时写 `claude,grok`）；`all`。0.27.3 的 hub 无远程探测（paths/exists 只认目录，配置目录残留会误报）；gemini 从类型清单剔除（该版本 hub 写死拒绝启动） |
| D3 | **命名：连字符拼接，无空格** | Agent 名里的空格一律换成连字符：`Claude-Code`、`Cursor-Agent`、`Grok-Build` |
| D4 | **只用 @ 触发** | 被 @ 或私聊时才响应。不做静默读取；「用便宜模型判断是否主动插话」的想法**先不做**，跑起来再说 |
| D5 | **AI 消息永不触发 AI** | 任何 `role='ai'` 用户发的消息，都不会触发任何 AI 用户回复。这是防止多个 AI 互相 @ 出死循环的硬规则 |
| D6 | **Agent 不可用给固定回复** | @ 一个当前不可用的 Agent（机器离线 / Agent 被卸载 / 会话起不来），它回一条：`「<Agent 名> 暂不可用，请联系管理员」` |
| D7 | **每个 Agent 独立目录** | 各自有专属工作目录，记忆文件互不干扰（见 §E） |
| D8 | **Agent 只能管理员拉进群** | 普通成员不能把 AI 用户加进群；私聊不受限（联系人里「去聊天」即可） |
| D9 | **在途请求不落库** | 我们只负责把请求发到 hapi。等待回复期间 Loop IM 重启，这条回复就不贴回聊天了（hapi 侧会话里仍在），用户重新问一次即可。不做补偿机制 |
| D10 | **权限模式 yolo** | Agent 在自己的工作目录里自主干活，不做审批转发（风险见 §H） |
| D11 | **Aria 整体退役** | 删掉现有 Aria：供应商直连（OpenAI/Grok/Codex endpoint）、画像与学习、静默读取、@全员触发、AI 私聊开关、AI 统计，全部下线（迁移见 §F） |
| D12 | **纯 API 对接，配置切环境** | 本地开发连自己的 hub（hapi-server），线上连 Sophie-VPS 那套。代码零差异，只换配置（见 §C.1） |
| D13 | **消息原样转发**（2026-08-31，替代早期「拼上下文」想法） | 上下文由 hapi 会话自身在底层携带、由本地 Agent CLI 管理——我们只把这条消息发出去（参照 HapiKmp 手机客户端：请求体就是 {text, localId}）。会话模型因此改为**每个「Agent × IM 会话」一条 hapi 会话**（§C.3'）。私聊原文直达，**第一条也零注入**——人设/规矩在工作目录的 CLAUDE.md / AGENTS.md（启用 Agent 时自动铺设，已有不覆盖；线上容器摸不到宿主目录，铺文件属部署清单）。群聊的递话格式后由 D14 接管 |
| D14 | **群聊补课批次**（2026-09-01，用户实测拍板） | 群里没 @ 它的消息不实时转发，Agent 对这些是「彻底没见过」——实测它只能对着单句硬答（连发两条没 @ 的再 @ 问「看到了吗」，它答非所问）。修法：每个「Agent × 群」记一个水位（`hapi_sessions.last_seen_rowid`），被 @ 时把水位之后、触发消息为止的消息按序打包成一段文本，每条带 `[HH:MM] 署名：`（时区 `HAPI_TZ`，默认北京时间），跨天插「—— M月D日 ——」行，最后一条就是触发消息；**发送成功才推水位**（失败下次重补，宁可重见不能永久丢）。只算它进群之后的，首次封顶 `HAPI_BACKLOG_CAP`（默认 50）条；自己的回帖不重发，**其他 AI 的带上**（否则同群 Agent 互相隐身；只是看见，D5「AI 不触发 AI」不变）；系统提示不带；站内附件降级占位（[图片]/[文件：名字]）。与 D13 不冲突：D13 砍的是重复拼已知历史，这里补的是**从没送达过**的消息。实现见 `server/src/hapi/backlog.js` |
| D15 | **执行过程落库可回看**（2026-09-01，用户实测拍板） | Agent 干活的中间过程（说明文字、工具动作）此前全被丢弃——只贴最终回复，等待期间没有任何反馈，事后也无从回看（Codex 画图实测：4 段中间文字 + 8 次工具调用全部不可见）。修法：独立表 `hapi_turn_steps` 按步落库（turn_id 归组，回复贴出后挂 `reply_message_id`），**中间文字存全文、工具动作存一句人话标签**（优先工具自带描述，其次剥壳后的命令/路径）；工具结果与推理独白不存（噪音）；同一调用的多条状态更新按 callId 只记一次；hapi 内部杂务（改会话标题）不记；步数封顶 `HAPI_STEPS_MAX`（默认 200）。展示两态同源：进行中每步实时推 `ai-progress`，「正在输入」行下滚动显示最新一步；结束后回复气泡下挂「执行过程 · N 步」折叠行，点开按需拉时间线（GET `/:id/messages/:mid/steps`，仅会话成员）。失败文案（暂不可用/超时）同样挂过程——出事时一看就知道卡在哪步。私聊群聊同一套。实现见 `server/src/hapi/steps.js` |

一条**未拍死**的：一个群里允许同时有多个 Agent 吗？D5 已经把死循环堵住，D8 又只有管理员能拉，
本方案倾向**允许**（比如一个群里同时有 Claude-Code 和 Codex，各干各的）；如果实际用出问题，
再加「一群一 Agent」的限制，改动只在拉人校验一处。

---

## B. hapi 侧的事实（对接依据）

hapi hub 提供完整的 HTTP API。⚠️ **以线上实际部署的 0.27.3 为准**（其仓库 `docs/api/client-contract/`
是主干新版的文档，个别接口 0.27.3 还没有）。要用到的（已逐条对过 v0.27.3 tag 的 hub 源码，
并对真实 hub 验证过）：

| 端点 | 用途 |
| --- | --- |
| `POST /api/auth` | 拿 access token 换 JWT（**4 小时过期**，401 时用存着的 token 重换） |
| `GET /health` | 连通性与协议版本 |
| `GET /api/machines` | 列出在线机器（我们只认配置里指定的那一台） |
| `POST /api/machines/:id/spawn` | 开会话：`{directory, agent, yolo, ...}`，回 `{type:'success', sessionId}` |
| `GET /api/sessions/:id` | 查会话状态（`agentState` 判活） |
| `POST /api/sessions/:id/resume` / `reopen` | 复活断掉的会话 |
| `POST /api/sessions/:id/messages` | 发消息（回复经 SSE 到达） |
| `GET /api/sessions/:id/messages` | 翻会话历史（带游标） |
| `GET /api/events`（SSE） | 实时事件流：Agent 的回复从这里来 |

认证链路：hub 的 `CLI_API_TOKEN` 是根令牌 → 派生 access token（长期有效）→ 换 JWT（4h）。
服务端集成拿着 access token 就能全自动运转。请求要带自定义 UA（Cloudflare 拦默认 UA）。

**0.27.3 的一个现实**：没有「这台机器装了哪些 Agent」的查询接口（`agent-availability`
是后来主干上的新东西）。所以 D2 的「可用 Agent 列表」退化为**固定的 10 种官方类型**
（claude / codex / gemini / kimi / copilot / grok / cursor / opencode / pi / agy），
可用性只到「配置的那台机器在不在线」这一层：机器在线 = 启用的 Agent 全部可用；
离线 = 全体临时停用（勾选保留）。某个 Agent 其实没装的情形，等 @ 它开会话失败时按 D6 兜住。

---

## C. 我们这边的设计

### C.1 配置

**部署层配置（环境变量，`.env`）** —— 换环境只换这几个：

| 变量 | 说明 |
| --- | --- |
| `HAPI_BASE_URL` | hub 地址。本地开发：自己的 hapi-server；线上：Sophie 那套 |
| `HAPI_TOKEN` | access token。只存 `.env`，**绝不进 git**（本仓库公开） |
| `HAPI_MACHINE_ID` | 用哪台机器（本地：Mac runner；线上：Sophie-VPS runner） |
| `HAPI_WORKROOT` | Agent 工作目录的根，如 `~/Code/Chat/loop-im-agents`（线上按 Sophie-VPS 的目录约定） |

**产品层配置（AI 配置页，存库）**：

- 「可用 Agent」列表：固定的 10 种官方类型（见 §B 的 0.27.3 现实），勾选启用哪些；
- 每个 Agent 的显示名（默认按 D3 规则生成，可改）；
- 「测试连通性」按钮保留：打 `GET /health` + 列机器 + 列 Agent，一次把三层都验了。

未配置 `HAPI_BASE_URL` 时：不创建任何 AI 用户，整套系统就是纯人类 IM，
测试与 CI 离线照跑（沿用「Aria 未配 Key 降级」的老思路，但更干净——连模拟回复都不需要了）。

### C.2 用户映射

- 每个启用的 Agent 一行 `users`：`id = 'ai-<agent标识>'`（如 `ai-claude`）、`role = 'ai'`、
  名字按 D3。id 稳定，反复开关配置不产生重复用户。
- **可用性联动**（D2/D6）：配置保存或定时探测发现 Agent 不可用 → 自动停用该用户
  （复用现有停用机制：灰显、不出现在拉人名单）；恢复可用 → 自动启用。
  机器整个离线 → 全体 hapi 用户停用。
- @ 到一个「存在但临时不可用」的 Agent（探测有延迟时可能发生）→ 按 D6 回固定文案。

### C.3' 会话模型（2026-08-31 修订，替代下方原 C.3）

- **每个「Agent × IM 会话」一条 hapi 会话**：群 A 的讨论一直在群 A 对应的那条
  hapi 会话里延续，上下文由会话自身在底层携带，**不做任何文本拼接**（D13）。
- 递话格式：群聊 `张三：<原文>`（署名是接口层带不了的唯一额外内容）；私聊原文直达；
  **第一条与之后完全一致，零开场白**——人设与前缀读法在工作目录的 CLAUDE.md /
  AGENTS.md 里（enableAgent 时自动铺设，已有绝不覆盖），由各家 CLI 原生机制读取。
- 同一 Agent 的所有会话共用同一个工作目录（记忆文件是「个体」的，不分场合）。
- 判活照旧：发消息前查 → 死了 resume → 不行就同目录 spawn 新的；spawn/resume 受理后
  要**轮询到 active** 再发（Agent 进程要几秒启动，早发会被 409 拒）。
- **串行队列按「Agent × 会话」分**：同一会话内一次一件事；不同群/私聊各是独立的
  hapi 会话（独立进程），天然并行。
- 会话映射记在 `hapi_sessions`（agent_key × conversation_id → session_id）。

<details><summary>原 C.3（已废弃：每个 Agent 一条全局会话 + 拼最近 20 条上下文）</summary>
一个 Agent 一条会话导致多群串音，只能靠把最近 N 条拼进文本补课——重复、费 token、
且把上下文管理错放到了我们这层。用户点破后改为 C.3'。
</details>

### C.4 一条消息的完整旅程

```
1. 张三在群里发「@Claude-Code 帮我 xxx」
2. 服务端解析提及 → 命中 ai-claude → 检查发送者不是 AI（D5）
3. 该 Agent 的队列里排队；轮到时：
   a. JWT 有效？过期先 POST /api/auth 换新
   b. 会话活着？GET session → 死了 resume/reopen → 没有就 spawn（目录、agent、yolo）
   c. POST messages：`张三：<原文>`（私聊则是原文本身；第一条也不例外）
4. SSE 上等这个会话的最终回复（中间的工具调用过程不转发）
5. 以 ai-claude 的身份把回复贴回原会话，Markdown 渲染
6. 任何一步失败 → 按 D6 贴固定文案 + 服务端日志记原因
```

超时：Agent 任务可能跑很久，首版给单条请求设上限（建议 10 分钟），超了贴
「<Agent 名> 处理超时，任务可能仍在后台进行」并出队——会话里任务其实还在跑，
用户可以稍后再问一句拿结果。

### C.5 数据模型改动

- `users`：无需加列（`role='ai'` 已存在）；约定 `ai-` 前缀 id。
- 表 `hapi_agents`：`agent_key`、`user_id`、`enabled`（session_id 列已随 C.3' 弃用）。
- 表 `hapi_sessions`：`agent_key × conversation_id → session_id`，会话重开就地覆盖。
- `ai_settings` 表整体退役，hapi 的产品层配置进新表 `hapi_settings`（单行）。
- **不需要**在途请求表（D9）。

---

## D. 触发规则（完整版）

| 场景 | 行为 |
| --- | --- |
| 群里 `@<Agent名>` | 必回（走 §C.4） |
| 与 Agent 私聊发消息 | 每条都回（私聊即一对一，无需 @） |
| 群里普通聊天没 @ 它 | **完全不理**，也不读取（D4：无静默读取） |
| `@全员` | 不触发任何 AI 用户 |
| AI 用户发的消息 | 不触发任何 AI（D5，含它自己） |
| 一条消息 @ 多个 Agent | 各自独立触发，各回各的 |
| 被 @ 的 Agent 已停用/不可用 | 固定文案（D6） |

提及解析沿用现有 parseMentions（最长匹配、邮箱跳过），补两件事：
别名注册从「Aria 硬编码」改成「所有 `role='ai'` 用户的名字」；带连字符的名字加测试。

---

## E. 工作目录与人设（hapi 侧）

`HAPI_WORKROOT` 下每个 Agent 一个子目录（D7）：

```
loop-im-agents/
├── claude/            # Claude Code 的家
│   ├── CLAUDE.md      # 人设与守则（Claude Code 认这个文件名）
│   ├── people/        # 按人记忆：张三.md、李四.md……
│   └── groups/        # 按群记忆：发版讨论.md……
├── codex/
│   ├── AGENTS.md      # ⚠️ Codex 认的是 AGENTS.md，不是 CLAUDE.md
│   └── …同上
└── grok/
    └── …（按该 Agent 的指令文件约定）
```

人设文件（CLAUDE.md / AGENTS.md）要写清楚的守则，草稿：

1. 你是 Loop IM 团队聊天里的成员「Claude-Code」，消息都带来源前缀，回复用中文、Markdown、说人话；
2. **每次会话开始，先读 people/ 与 groups/ 下相关文件恢复记忆**；
3. 对话里出现值得长期记住的信息（某人的偏好、项目约定、未完成的事），随手更新对应记忆文件；
4. **隐私红线：people/ 下 A 的私聊记忆，不得在别人的对话里引用或透露**（这是提示词级别的
   软约束，团队知情并接受——见 §H）；
5. 干活产生的文件放自己目录里，别往目录外写。

对话完整记录不需要 Agent 自己抄写——hapi hub 的会话历史天然全量保存，随时可在控制台翻。
目录里的文件是**提炼过的记忆**，不是流水账。

---

## F. Aria 退役方案（D11）

**彻底清除，不留任何痕迹**（2026-08-28 拍板：线上没人跟它聊过，不需要兼容）。

| 项 | 处置 |
| --- | --- |
| Aria 用户（`id='ai'`） | **连数据一起删**：启动时一次性清除它的用户行、发过的消息（各群欢迎语）、AI 私聊会话、群成员行与已读行（`db.js` 的 `purgeLegacyAi()`，幂等） |
| 供应商直连（OpenAI/Grok/Codex endpoint）、`callProvider` | 删代码 |
| 画像与学习（`ai_profiles`、`learnAbout`、`ai_visible` 判定） | 删代码；`ai_settings` / `ai_profiles` 两张表老库里 **DROP 掉**、新库不再创建；`messages.ai_visible` 列新库不建、老库遗留列不再读写（SQLite 删列要重建整表，不值得） |
| 静默读取开关、@全员触发开关、AI 私聊开关 | 随 `ai_settings` 一起退役 |
| AI 管理页 | 重做为「hapi Agent 管理」：连接状态、Agent 勾选列表、测试连通性。画像二级页、统计（今日被 @）删除 |
| 建群自动拉 Aria | 删除。新群默认没有任何 AI，管理员按需拉（D8） |
| bootstrap 创建 Aria | 删除；清库由 db.js 的 purgeLegacyAi() 负责 |
| 相关测试（ai.test.js、issue-1、画像、@Aria e2e 等，约几十个文件） | 删除或改写为 hapi 版等价用例 |
| README、docs/测试用例.md 的 L/M 两节 | 全量改写 |

升级注意：升级后 Aria 从联系人、群成员、历史消息里**整体消失**（它发过的欢迎语一并删除），人类之间的聊天一个字不动。

---

## G. 边界情况逐条

| 情况 | 行为 |
| --- | --- |
| hapi hub 整个失联 | 所有 Agent 用户停用；@ 到（竞态窗口内）→ D6 文案 |
| runner/机器离线 | 同上（`GET /api/machines` 里看不到 → 停用） |
| 会话被 hapi 更新杀掉 | 下次请求时判活→重开→靠记忆文件续命，用户无感 |
| spawn 失败（目录不存在/agent 报错） | D6 文案 + 日志；不重试轰炸 |
| JWT 过期 | 401 → 自动换新 → 重发一次；再失败按 D6 |
| Loop IM 重启时有在途请求 | 回复丢失（D9 已接受）。用户再问一次即可 |
| 两人同时 @ 同一 Agent | 串行队列，第二条排队，「输入中」持续显示 |
| 队列積压过深 | 超过阈值（建议 5 条）直接回「<Agent 名> 排队请求过多，请稍后再试」 |
| Agent 回复超长 | 照贴（消息体是 Markdown，长内容可折叠是前端已有能力范围，首版不特殊处理） |
| access token 被轮换 | 换 JWT 失败 → 全体停用 + 管理页醒目报错，等管理员更新 `HAPI_TOKEN` |
| 限流 | @AI 的那一档限流保留（原来防的是烧钱，现在防的是把 Agent 队列打爆） |

---

## H. 安全（要有人知道的事）

1. **yolo + 生产同机 root runner**。线上用 Sophie 那套，其 runner 以 root 跑在
   **Loop IM 生产服务器同一台机器**上。放开权限意味着：任何能 @ Agent 的团队成员，
   理论上都能让它在那台机器上执行任意命令（包括读生产密钥、动生产数据）。
   团队内部互信 + 成员账号全由管理员开通，**接受这个风险**；但建议两个低成本缓解：
   - 给 Loop IM 接入单独起一个**非 root 的 runner**（专用 Linux 用户 + 专属目录）；
   - 至少把工作目录放在非 root 用户可写的独立位置，人设守则里写明「别出目录」。
2. **`HAPI_TOKEN` 是高权凭据**（能在 runner 机器上开任意会话）：加密落库（复用
   `ENCRYPTION_KEY` 那套 secret-box），日志与接口响应绝不回传，README 不出现真实值。
3. **隐私软约束**：§E 守则第 4 条只是提示词，不是隔离。私聊里跟 Agent 说的话，
   技术上对其他成员的对话是可达的。这一点写进用户可见的说明里，知情使用。
4. 本仓库公开：方案文档与代码里不出现服务器地址、token、内部域名的真实值。

---

## I. 测试计划

- **hapi mock**：测试里起一个假的 hub（HTTP + SSE，几个端点而已），覆盖：
  换 JWT、401 重试、判活、resume 失败转 spawn、SSE 收回复、超时、D6 各失败路径。
- **触发规则**：D4/D5 全表逐条（尤其 AI 不触发 AI、连字符名字的提及解析）。
- **用户联动**：勾选建用户 id 稳定幂等、取消停用、可用性探测联动。
- **Aria 退役回归**：历史消息可读、建群不再有 AI、老 e2e 改写。
- **CI 离线**：不配 `HAPI_BASE_URL` 时全绿。
- 真机联调清单（人工）：本地 hub 全流程 → 切 Sophie 配置联调 → 群聊/私聊/排队/杀会话重开各过一遍。

---

## J. 分期

（2026-08-28 调整：先清后建——Aria 退役提到第一步，把地基清干净再接 hapi。）

| 阶段 | 内容 | 出口条件 |
| --- | --- | --- |
| PR1 | **Aria 退役**（§F 全部）+ 文档与测试全量对齐。此阶段结束后系统暂时没有任何 AI，纯人类 IM | 全套测试绿；README/测试用例集改写完 |
| PR2 ✅ | hub 客户端（auth/判活/spawn/messages/SSE/回复文本抽取）+ 配置 + Agent→用户映射与联动 + 管理页 | **已达成**（2026-08-31）：假 hub 下 22 条用例全绿；真 hub 验通（Avz-Studio 在线、启用 claude 即建出 ai-claude、停用即隐身） |
| PR3 ✅ | 消息流转全链路：@ 触发、串行队列、来源前缀 + 最近 20 条上下文、会话保活（判活→resume→spawn）、回合判定（thinking 翻转 + 文本安静兜底）、D6/超时/排队文案、「输入中」按会话计数 | **已达成**（2026-08-31）：假 hub 下 10 条链路用例全绿；**真 hub 真 Claude Code 跑通**——DM 发 ping，11 秒收到真实回复贴回聊天 |
| 上线 ✅ | Sophie-VPS 侧准备 → 切配置部署 | **已达成**（2026-08-31）：hub sophie-ai + 宿主机 runner，HAPI_AGENTS=codex,grok，工作目录与守则文件已铺（/home/sophie/Code/Chat/loop-im-agents），Aria 数据线上清除确认，真实冒烟 Grok 25 秒回复 |

线上前要做的一次性决定：Sophie-VPS 上跑哪些 Agent。当前那台只有 Grok；
要 Claude-Code 就得在那台服务器装 claude 并完成认证（属部署动作，不是代码）。
