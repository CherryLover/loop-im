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

## 备份与迁移

```bash
tar czf loop-im-backup-$(date +%F).tar.gz data .env     # 备份
# 迁移：把这个包解到新机器的同一个目录，再跑 ./deploy.sh
```
