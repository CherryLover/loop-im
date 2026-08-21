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
    ├── uploads/
    └── minio/      ← 只有启用了 MinIO 才有（见「附件存到 MinIO」）
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

## 附件存到 MinIO（可选）

默认附件就落在 `data/uploads/`，不用 MinIO 也完全能跑 —— 下面这一节只在你想把附件
挪到对象存储时才需要。**不填 `S3_BUCKET` 就什么都不会变。**

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

### 切换步骤

附件下载现在还要求「你是该附件所在会话的成员」，所以顺序别搞反。

```bash
# 1. 填凭据（.env 不进 git，仓库里没有也不该有任何密钥）
openssl rand -hex 24                # 分别填进 S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
vi .env                             # 打开 S3_BUCKET / S3_ENDPOINT / S3_* 那几行

# 2. 起 MinIO（注意 --profile，不加的话这个服务根本不会被启动）
docker compose --profile minio up -d minio

# 3. 建桶（MinIO 不会自动建）。用一次性的 mc 容器，跟 minio 在同一个网络里：
docker compose --profile minio run --rm --entrypoint sh minio -c \
  'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc mb -p local/loop-im'

# 4. 重启应用，让它读到新的 S3_* 变量
./deploy.sh
```

这一刻起**新**附件直接进桶，**老**附件继续从本地磁盘回落（双读，见下），
所以中间没有任何一刻是坏的。

```bash
# 5. 从容地把老文件搬进桶。默认是预演，什么都不改。
docker compose run --rm loop-im node scripts/migrate-uploads-to-minio.mjs
docker compose run --rm loop-im node scripts/migrate-uploads-to-minio.mjs --apply

# 6. 数目核对无误、并且备份过 data/ 之后，才关掉本地回落
#    在 .env 里设 UPLOADS_LOCAL_FALLBACK=0，再 ./deploy.sh
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
应用内置了一个后台任务，默认每小时扫一次，回收「超过 24 小时、且没有任何消息引用」的对象
（`UPLOAD_ORPHAN_TTL_HOURS` / `UPLOAD_SWEEP_INTERVAL_MINUTES` 可调）。
头像、以及库里查不到 `attachments` 记录的历史对象一律不碰。

### 上线自检清单

自动化测试里**没有真的起一个 MinIO 容器**（对象存储被抽象成可替换接口，用例跑的是内存实现），
签名算法只由 AWS 官方向量覆盖。所以第一次切过去时请手工确认这几条：

- [ ] 发一张图，能看到；换个同群的账号也能看到
- [ ] 发一个 `.pdf`/`.zip`，点击是**下载**而不是在浏览器里打开
- [ ] 换一个不在这个群的账号去开同一个附件地址 → `404`
- [ ] 退出登录后开附件地址 → `401`
- [ ] `docker compose logs minio` 里没有 `SignatureDoesNotMatch`
- [ ] 宿主机上 `curl http://127.0.0.1:9000` **连不上**（MinIO 不该对外）

## 备份与迁移

```bash
tar czf loop-im-backup-$(date +%F).tar.gz data .env     # 备份
# 迁移：把这个包解到新机器的同一个目录，再跑 ./deploy.sh
```
