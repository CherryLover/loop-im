# 部署

服务器上只需要这个目录里的三个文件：`docker-compose.yml`、`deploy.sh`、`.env`。
数据都落在与它们同级的目录里，**主程序和对象存储各一个**：

```
你的服务器上任意路径，例如 /opt/loop-im/
├── docker-compose.yml
├── deploy.sh
├── .env             ← 自己填，不进 git
├── data/            ← 自动创建。主程序：SQLite 库、迁移前的本地附件
│   ├── loop.db
│   └── uploads/
└── minio-data/      ← 自动创建。MinIO：附件对象
```

两个数据目录**刻意分开**：库和对象的生命周期不一样，分开之后能单独备份、单独搬迁，
出问题时也能只清其中一个而不误伤另一个。整个目录打包走就是完整迁移。

`loop-im` 和 `minio` 两个容器随 compose 一起启停，没有可选项、没有额外开关。
**桶不需要手工建** —— 主程序启动时会自己检查并创建，还会跑一个写入 → 读回 → 删除的
来回自检，通过了才开始对外服务（见 `server/src/index.js`）。

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

`deploy.sh` 做的事：检查 docker 与配置 → 缺对象存储凭据就生成 → 准备 `data/` 与
`minio-data/` → 拉镜像 → 停旧起新 → 轮询 `/api/health` 最多 120 秒 →
成功则记录版本并清理悬空镜像，失败则打印日志并提示回滚。
（超时给到 120 秒是因为现在要多等 MinIO 健康检查加主程序自检那几秒。）
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

### ⚠️ 反代必须放行 100MB 的请求体，否则视频根本传不上去

视频附件上限是 **100MB**（图片和普通文件仍然是 8MB）。反向代理默认的请求体上限比这
小得多，**不改配置的话请求连 Node 都到不了**，用户看到的是反代自己吐的一个英文
`413 Request Entity Too Large`，而不是我们的中文提示 —— 服务端日志里一行都没有，
排查起来很费劲。

Nginx 的 `client_max_body_size` 默认只有 **1MB**，这一条一定要改：

```nginx
server {
    server_name im.example.com;

    # ★ 必改：默认 1MB，不改的话 100MB 的视频到不了 Node。
    #   留一点余量给 multipart 的边界和表单字段，别正好写 100m。
    client_max_body_size 105m;

    # 100MB 的上传别落到 Nginx 的磁盘缓冲里再转发：直接边收边转，省一次整份磁盘往返。
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 慢网络传 100MB 要不少时间，默认 60s 会在半路掐断。
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;
    }

    # SSE 是长连接，必须关掉缓冲，否则消息会被攒着不发。
    location /api/stream {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;
    }

    # 视频回源走 Range（206）。别在这条路径上开 gzip：压缩会让 Nginx 丢掉
    # Content-Length / Content-Range，Safari 和 iOS 会直接不播。
    location /uploads/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Range $http_range;            # Range 必须透传下去
        proxy_set_header If-Range $http_if_range;
        gzip off;
        proxy_buffering off;
    }
}
```

Caddy 默认**不限制**请求体大小，所以上面那个最小示例已经能传 100MB。真要设个上限，
用 `request_body`，同样记得留余量；Caddy 会自动透传 Range 并且不压缩 `video/*`：

```
im.example.com {
    # 不写这一段就是不限制。写了就别小于 105MB，否则视频传不上去。
    request_body {
        max_size 105MB
    }

    reverse_proxy 127.0.0.1:4000 {
        # SSE 和视频都要求别缓冲。
        flush_interval -1
    }
}
```

其它常见的一层：Cloudflare 免费版的上限是 **100MB**（企业版才能调大），正好卡在我们
的上限上 —— 套了 Cloudflare 代理的话，实际能传的会比 100MB 略小一点点（multipart 的
开销会让一份 100MB 的视频超过 100MB 的请求体）。要么给 `/api/uploads` 关掉橙云走直连，
要么把 `MAX_VIDEO_MB` 调小。

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

## 附件对象存储（MinIO）

MinIO 随 compose 一起启停，数据在与 compose 文件同级的 `minio-data/`。
**不需要任何手工步骤**：凭据由 `deploy.sh` 首次运行时生成，桶由主程序启动时创建。

### 架构：浏览器永远不直连 MinIO

```
浏览器 ──GET /uploads/<key>（带凭据）──> Express ──内网──> minio:9000
                                          │
                                          └── 由 Express 加上安全头再转发
```

MinIO **不映射任何端口到宿主机**，只在 compose 的内部网络里可达。这不是偷懒，是必须的：

附件的全部安全防护（issue #22）都长在回源那一层 —— 按扩展名白名单钉死 `Content-Type`、
非图片一律 `Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`、
外加一条 `default-src 'none'; sandbox` 的 CSP。只要让浏览器直接去对象存储取文件
（预签名 URL、公开桶、CDN 回源，随便哪种），这组头就全部消失，MinIO 会按对象自己的
Content-Type 返回，一份存进去的 HTML 会被当网页渲染 —— 存储型 XSS 当场复活，
而且是在**和聊天系统同源**的页面里，能直接读走登录凭据。

所以策略只有一处：`server/src/attachments.js` 的 `setUploadHeaders`，
由 `server/src/routes/upload-files.js` 原样调用。别绕开它。

> 想看 MinIO 控制台就开 SSH 隧道（`ssh -L 9001:127.0.0.1:9001 user@server`）临时映射，
> 不要在 `docker-compose.yml` 里长期加 `ports:`。

### 启动时都发生了什么

`./deploy.sh` 之后不需要你做任何事，顺序是这样的：

```
deploy.sh      → .env 里 S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY 为空就生成写回
                 建好 data/ 与 minio-data/ 两个目录
compose up     → minio 起来，healthcheck（mc ready local）通过
                 loop-im 靠 depends_on: service_healthy 等到这一刻才启动
loop-im 启动   → HEAD /loop-im          桶在不在
                 PUT  /loop-im          不在就建（已存在返回 409 也算成功）
                 PUT/GET/DELETE probe   写一个探针对象、读回来比对、删掉
                 ↑ 全过了才 listen 端口对外服务
```

**为什么要跑读写来回，光看桶在不在不够**：桶在、但凭据只读，或者策略不让写，
要拖到用户第一次发图才暴露。跑完整一个来回才算真的准备就绪。

**自检不通过会怎样**：重试 20 次（每次隔 1 秒），仍然失败就打一条 `store.unavailable`
错误日志并退出，交给 `restart: unless-stopped` 重来。这是刻意的 —— 容器显示 Up、
聊天能用、只有发图坏，这种半开状态往往要等用户来报才被发现；
`docker compose ps` 里明明白白一个 Restarting 好查得多。

```bash
docker compose logs loop-im | grep -E 'store\.(ready|unavailable|not-ready)'
```

### 从旧版本升级：老附件怎么办

如果你的 `data/uploads/` 里还有切换前的本地附件，它们**不会自动消失也不会 404**：
新附件直接进桶，老附件继续从本地磁盘回落（双读），中间没有任何一刻是坏的。

```bash
# 从容地把老文件搬进桶。默认是预演，什么都不改。
docker compose run --rm loop-im node scripts/migrate-uploads-to-minio.mjs
docker compose run --rm loop-im node scripts/migrate-uploads-to-minio.mjs --apply

# 数目核对无误、并且备份过 data/ 之后，才关掉本地回落
# 在 .env 里设 UPLOADS_LOCAL_FALLBACK=0，再 ./deploy.sh
```

**双读**（`server/src/storage.js` 的 `getObject`）：主存储里没有的对象自动回落到本地磁盘。
少了这一步，切换的那一刻起所有老图立刻 404。搬完并确认之后再关。

### 附件鉴权

`/uploads/<key>` 从「谁都能下载」改成了：

| 情况 | 结果 |
| --- | --- |
| 未登录 / 凭据失效 / 账号已停用 | `401` |
| 是该附件所在会话的成员 | `200` |
| 不是成员 | `404 附件不存在` |
| 附件根本不存在 | `404 附件不存在`（和上一行**逐字相同**，不做存在性探针） |
| 自己传了还没发出去的 | `200`（只有上传者本人） |
| 头像 | 登录即可，全员可见（见下） |

**头像是另一套规则**：它出现在成员列表、@提及候选、搜索结果里，任何登录用户本来就能从
`/api/users` 拿到全站每个人的 `avatarUrl`，按会话卡它挡不住任何东西，只会让还没建立
会话的两个人互相看不到头像。所以头像只要求「登录且未停用」。

**历史附件的降级**：升级前落下的、库里查不到任何归属记录的老对象（`attachments` 表建立
之前的产物，或运维手工放进 `uploads/` 的文件），数据库里没有任何线索能说出它属于哪个会话。
默认按 `UPLOADS_LEGACY_ACCESS=authenticated` 处理 —— 登录即可下载。这相对现状（**谁都能
下载，连登录都不用**）是严格收紧，而且不会让任何老图挂掉。确认过没有还在被引用的老对象之后，
可以改成 `deny`。

> 升级时会自动跑一次回填：扫历史消息正文里的 `/uploads/...` 链接，把附件补挂到对应会话上。
> 所以绝大多数历史附件是有归属的，落进上面这条降级的只是极少数。

### 孤儿对象清理

前端在**选中文件的那一刻**就把文件传上去了，用户改主意移除附件或者干脆不发，对象也已经落库。
应用内置了一个能回收这类对象的后台任务，但它**默认是关的**——这套清理会真的删用户传上来的
文件，而本项目的取向是程序层面不主动删数据，桶涨多大交给运维侧的转存 / 备份去管。
不配置就是一个字节都不删，桶只会一直涨，这是有意为之。

真要开，显式打开即可（`on` / `true` / `1` 都认）：

```bash
UPLOAD_ORPHAN_SWEEP=on
```

开了之后默认每小时扫一次，回收「超过 24 小时、且没有任何消息引用」的对象
（`UPLOAD_ORPHAN_TTL_HOURS` / `UPLOAD_SWEEP_INTERVAL_MINUTES` 可调）。
就算开着，这几类也一律不碰：已经发出去的附件（`attachment_refs` 有记录、或正文里直接引着它，
两道独立判定）、头像（不进 `attachments` 表）、以及库里查不到 `attachments` 记录的历史对象。

启动日志里能直接看出当时是开是关：开着记 `uploads.sweeper.started`（带 TTL 与间隔），
关着记 `uploads.sweeper.disabled`。

### 上线自检清单

自动化测试里**没有真的起一个 MinIO 容器**（对象存储被抽象成可替换接口，用例跑的是内存实现），
签名算法只由 AWS 官方向量覆盖。所以第一次切过去时请手工确认这几条：

- [ ] 发一张图，能看到；换个同群的账号也能看到
- [ ] 发一个 `.pdf`/`.zip`，点击是**下载**而不是在浏览器里打开
- [ ] 换一个不在这个群的账号去开同一个附件地址 → `404`
- [ ] 退出登录后开附件地址 → `401`
- [ ] `docker compose logs minio` 里没有 `SignatureDoesNotMatch`
- [ ] 宿主机上 `curl http://127.0.0.1:9000` **连不上**（MinIO 不该对外）

视频那一档还要多过几条。**Range 透传给 MinIO 这条自动化测试完全覆盖不到**
（用例里的假桶是我们自己写的 Node http server，按我们理解的语义回 206/416），
所以它只能在这里人工确认：

- [ ] 传一个几十 MB 的 MP4，能在聊天里**直接播**（不是下载）
- [ ] 拖进度条到中间，能从那里接着播 —— 这一条验的就是 206
- [ ] 用 iPhone / Safari 打开同一条消息，视频能播（没有 Range 的话 Safari 直接不播，
      这是最容易在 Chrome 上测不出来的一档）
- [ ] `curl -sI -H 'Range: bytes=0-99' 'https://im.example.com/uploads/<key>?token=<token>'`
      → `206`，带 `Content-Range: bytes 0-99/<总长>` 和 `Accept-Ranges: bytes`
- [ ] 同样的地址给一个越界的范围（`-H 'Range: bytes=999999999-'`）→ `416`，
      带 `Content-Range: bytes */<总长>`
- [ ] 上面两条的响应里都有 `X-Content-Type-Options: nosniff`，**没有** `Content-Disposition`
- [ ] `docker compose logs minio` 里没有 `SignatureDoesNotMatch`（Range 是签进签名里的，
      反代要是偷偷改写了这个头，这里会立刻报出来）
- [ ] 传一个 100MB 的视频成功；再传一个 101MB 的，看到的是**我们的中文提示**
      而不是反代自己吐的英文 `413`（后者说明 `client_max_body_size` 没改）
- [ ] 服务器上 `du -sh data/tmp` 在几次上传前后都接近 0 —— 中转文件没有攒下来

## 备份与迁移

```bash
# 备份：两个数据目录 + 配置。少打 minio-data 就等于把所有附件丢了。
tar czf loop-im-backup-$(date +%F).tar.gz data minio-data .env

# 迁移：把这个包解到新机器的同一个目录，再跑 ./deploy.sh
```

两个目录分开，所以也可以只备份其中一个：`data/` 是库（丢了聊天记录就没了），
`minio-data/` 是附件对象（丢了消息还在，图片变裂图）。**不要只备份 `data/`** ——
切到对象存储之后，附件已经不在那里面了。
