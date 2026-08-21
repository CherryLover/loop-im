# 部署

服务器上只需要这个目录里的三个文件：`docker-compose.yml`、`deploy.sh`、`.env`。
所有数据（SQLite 库与图片附件）都落在与它们同级的 `data/` 目录里 —— 备份就是打包这个目录。

```
你的服务器上任意路径，例如 /opt/loop-im/
├── docker-compose.yml
├── deploy.sh
├── .env            ← 自己填，不进 git
└── data/           ← 自动创建，SQLite + 上传的图片
    ├── loop.db
    └── uploads/
```

## 首次部署

```bash
# 1. 把这三个文件放到服务器上（在服务器上执行）
mkdir -p /opt/loop-im && cd /opt/loop-im
curl -fsSLO https://raw.githubusercontent.com/CherryLover/loop-im/main/deploy/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/CherryLover/loop-im/main/deploy/deploy.sh
curl -fsSLO https://raw.githubusercontent.com/CherryLover/loop-im/main/deploy/.env.example
chmod +x deploy.sh

# 2. 填配置
cp .env.example .env
openssl rand -hex 32          # 填进 JWT_SECRET
vi .env                       # 再填 ADMIN_EMAIL / ADMIN_PASSWORD

# 3. 一键部署
./deploy.sh
```

跑完会打印容器状态和最近日志，服务在 `http://127.0.0.1:4000`（默认只监听本机）。

## 日常操作

```bash
./deploy.sh              # 拉取最新镜像并重启（更新就是它）
./deploy.sh v1.2.0       # 部署指定版本
./deploy.sh --rollback   # 回到上一次成功部署的版本
./deploy.sh --status     # 看当前状态
./deploy.sh --logs       # 跟日志
```

`deploy.sh` 做的事：检查 docker 与配置 → 准备 `data/` → 拉镜像 → 停旧起新 →
轮询 `/api/health` 最多 90 秒 → 成功则记录版本并清理悬空镜像，失败则打印日志并提示回滚。
它是幂等的，重复执行没有副作用；健康检查不过时不会把失败当成功。

## 从远端一条命令部署

```bash
ssh user@your-server '/opt/loop-im/deploy.sh'
ssh user@your-server '/opt/loop-im/deploy.sh v1.2.0'
```

## 镜像

由 GitHub Actions 的 Docker 工作流构建并推送到 `ghcr.io/cherrylover/loop-im`：

| 触发 | 标签 |
| --- | --- |
| push 到 main | `latest` 与 `<短 SHA>` |
| 打 tag `v1.2.0` | `1.2.0`、`1.2`、`latest` |

> **第一次发布后要做一次**：GitHub 上 Packages → `loop-im` → Package settings，
> 把可见性改成 Public，服务器才能免登录拉取。想保持私有就在服务器上先
> `echo <GITHUB_TOKEN> | docker login ghcr.io -u <用户名> --password-stdin`。

## 对外提供 HTTPS

容器默认只绑定 `127.0.0.1:4000`，前面套一层反向代理即可（Caddy 示例）：

```
im.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

需要直接对外时，把 `.env` 里的 `BIND_ADDRESS` 改成 `0.0.0.0`。
注意 SSE 走的是长连接，Nginx 需要 `proxy_buffering off;` 与足够长的 `proxy_read_timeout`。

## 看日志

服务端的关键事件是**结构化日志**：一行一条 JSON，直接打到 stdout / stderr。
不落文件，所以没有日志轮转和磁盘写满的问题 —— 容器的输出本来就被 Docker 收着。

```bash
docker compose logs -f loop-im                  # 跟实时日志
docker compose logs --since 1h loop-im          # 最近一小时
docker compose logs --tail 200 loop-im          # 最后 200 行
docker compose logs --since 24h loop-im > loop-im-$(date +%F).log   # 导出给别人看
```

`info` 走 stdout，`warn` / `error` 走 stderr，所以只想看出问题的那些：

```bash
docker compose logs loop-im 2>&1 1>/dev/null    # 只要 stderr
```

装了 `jq` 的话按字段筛最省事（非 JSON 的启动提示用 `-R -c 'fromjson?'` 跳过）：

```bash
# 某个人今天都做了什么
docker compose logs --since 24h loop-im | jq -R -c 'fromjson? | select(.userId == "u_abc123")'

# 所有管理动作（审计）
docker compose logs --since 7d loop-im | jq -R -c 'fromjson? | select(.event | startswith("admin."))'

# 登录失败按原因归类
docker compose logs --since 24h loop-im \
  | jq -R -c 'fromjson? | select(.event == "auth.login.failed") | .reason' | sort | uniq -c

# AI 一天调用了多少次、总耗时多少（这是唯一直接花钱的路径）
docker compose logs --since 24h loop-im \
  | jq -R -c 'fromjson? | select(.event | startswith("ai.call."))' \
  | jq -s 'group_by(.event) | map({事件: .[0].event, 次数: length, 总毫秒: (map(.ms) | add)})'

# 顺着一次请求把相关的几行串起来（reqId 见下）
docker compose logs --since 1h loop-im | grep '"reqId":"3f9a1c2b"'
```

### 每行都有的字段

| 字段 | 含义 |
| --- | --- |
| `ts` | ISO 8601 时间戳（UTC） |
| `level` | `info` / `warn` / `error` |
| `event` | 事件名，形如 `auth.login.ok`，按 `.` 分层 |
| `reqId` | 请求关联 id，8 位十六进制。同一次 HTTP 请求产生的多行日志共用一个 |

`reqId` 同时回写在响应头 `X-Request-Id` 里。**用户来报障时先问他这一串**，
拿着它 grep 一次就能捞出那次请求的全部日志，不用靠时间戳去猜——并发一高就猜不准了。
后台任务（Aria 的回合、SSE 断开）不属于任何一次请求，没有这个字段。

### 有哪些事件

**鉴权**

| 事件 | 级别 | 说明 |
| --- | --- | --- |
| `auth.login.ok` | info | 登录成功。`userId` / `role` / `ip` / `remember` |
| `auth.login.failed` | warn | 登录失败。`reason` 为 `no_such_account` / `bad_password` / `account_disabled` |
| `auth.login.throttled` | warn | 触发登录限流。`waitMs` 是还要等多久 |
| `auth.credential.rejected` | warn | 拿着凭据被拒。`reason` 为 `token_invalid` / `user_gone` / `account_disabled` / `token_version_missing` / `password_changed` / `session_ended` |
| `auth.logout` | info | 主动退出。`stillOnline` 表示他是否还有别的设备在线 |
| `auth.password.changed` | info | 本人改密码（管理员重置见下面的审计那档） |

**管理动作（审计：谁、对谁、什么时候）**

| 事件 | 说明 |
| --- | --- |
| `admin.user.created` | 开通账号。`actorId` 操作者，`targetId` 被操作者 |
| `admin.user.password_reset` | 管理员重置他人密码 |
| `admin.user.disabled` / `admin.user.enabled` | 停用 / 恢复账号 |
| `admin.ai.settings_changed` | 改 AI 配置。`apiKeyChanged` 只说明密钥换没换 |
| `group.created` | 建群。`conversationId` / `memberCount` |
| `group.members_added` | 加人。`targetIds` |
| `group.member_removed` | 移除成员。`targetId` |

**AI 调用**（唯一直接花钱的路径，所有供应商调用都收敛在这里）

| 事件 | 级别 | 说明 |
| --- | --- | --- |
| `ai.call.ok` | info | `provider` / `model` / `ms` 耗时 / `sentMessages` 送进去几条 / `replyChars` 回来多少字 |
| `ai.call.failed` | warn | 同上，外加 `reason`。是 warn 不是 error：失败会退回本地模拟回复，产品还能用 |
| `ai.turn.failed` | error | Aria 的后台回合整个炸了（响应已经发出，只能记在这里） |

**连接与错误**

| 事件 | 级别 | 说明 |
| --- | --- | --- |
| `sse.connected` / `sse.disconnected` | info | 实时连接建立 / 断开。`connections` 是这个人当前还剩几条 |
| `sse.force_disconnected` | info | 停用账号时主动掐断。跟 `admin.user.disabled` 对着看 |
| `http.error` | error | 5xx。`method` / `path` / `status` / `err` |
| `server.started` | info | 进程起来了。`port` / `env` |

### 哪些事情**不**记

刻意为之，不是漏了：

- **消息正文、密码（含哈希）、JWT、AI 的 api_key、附件内容** —— 这是红线。
  日志的留存时间和访问范围都比数据库宽松得多，正文一旦进来，等于把明文聊天记录
  又抄了一份到一个更容易被看到的地方。定位问题一律用 id 和长度（`conversationId` /
  `messageId` / `userId` / `bytes`）。`server/test/log-events.test.js` 里有一组用例
  专门盯着这条线：把特征字串喂进系统跑一遍真实请求，断言它一次都没出现在日志里。
- **邮箱**：登录失败只记 `userId` 和 `ip`。每失败一次就抄一个邮箱进去，攒久了就是一份账号清单。
- **每条消息、每次轮询、每次已读上报**：量太大，记了只会把真正重要的事件淹掉。
- **4xx**：参数传错是调用方的事，没有排查价值。只有 5xx 进 `http.error`。
- **没带 token 的匿名请求**：前端没登录时每次刷新都来一发。

### 排障常用的几条

```bash
# 有人说「登不上去」
docker compose logs --since 1h loop-im | jq -R -c 'fromjson? | select(.event | startswith("auth."))'

# 有人说「莫名其妙被踢下线了」——看 reason 是改密码、被停用还是会话过期
docker compose logs --since 6h loop-im \
  | jq -R -c 'fromjson? | select(.event == "auth.credential.rejected") | {ts, userId, reason}'

# 有人说「Aria 不回话」
docker compose logs --since 1h loop-im | jq -R -c 'fromjson? | select(.event | startswith("ai."))'

# 服务在报错
docker compose logs --since 1h loop-im | jq -R -c 'fromjson? | select(.level == "error")'
```

> 需要长期留存或跨机器检索时，这些行是标准 JSON，直接喂给 Loki / Vector / ELK 即可，
> 不用改代码。日志量的大头是 SSE 连接事件，按 `event` 过滤就能压下来。

## 备份与迁移

```bash
tar czf loop-im-backup-$(date +%F).tar.gz data .env     # 备份
# 迁移：把这个包解到新机器的同一个目录，再跑 ./deploy.sh
```
