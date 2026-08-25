---
name: deploy
description: 更新 Loop IM 的线上部署：SSH 到生产服务器拉取最新镜像并重启（先下载、再停旧、后起新，数据不动），也支持回滚、查状态、看日志。当用户说"部署"、"更新线上"、"发布到线上"、"更新 soc"、"回滚线上"、"线上什么版本"时使用。
---

# 更新 Loop IM 线上部署

一切动作都通过 `deploy/remote-deploy.sh` 完成，不要手写 ssh 命令。
连接信息在 `deploy/.deploy.env`（不进 git）；缺了这个文件先照 `deploy/.deploy.env.example` 补齐。

## 更新到最新版（默认动作）

1. **先确认镜像是新的**。镜像由 GitHub Actions 在合入 main 时构建，合并后要等 Docker 工作流跑完再部署，否则拉到的还是旧镜像：

   ```bash
   git fetch origin main
   gh run list -R CherryLover/loop-im -b main -L 3
   ```

   确认最新一条 Docker 工作流的提交就是 origin/main 的 HEAD 且状态是 success。还在跑就等它（一般 1–2 分钟）。

2. **执行更新**：

   ```bash
   ./deploy/remote-deploy.sh
   ```

   服务器端的顺序是：拉新镜像（此时旧容器照常服务）→ 停旧容器 → 起新容器 → 本机健康检查。脚本最后还会从公网侧再验证一次健康接口。中断时间只有换容器的几秒；数据目录（SQLite + MinIO）不会被碰。

3. **核对版本**。确认线上跑的就是刚合并的提交：

   ```bash
   ./deploy/remote-deploy.sh --status
   ```

   需要精确核对时，可让服务器报镜像的构建来源提交（`org.opencontainers.image.revision` 标签），与 origin/main 的 HEAD 比对。

4. **向用户汇报**：部署到了哪个提交、健康检查结果、服务中断时长。汇报语言按用户的沟通偏好来（简单直白，不堆术语）。

## 其他动作

```bash
./deploy/remote-deploy.sh v1.2.0       # 部署指定版本 tag
./deploy/remote-deploy.sh --rollback   # 回滚到上一次成功部署的版本
./deploy/remote-deploy.sh --status     # 看容器状态
./deploy/remote-deploy.sh --logs       # 跟踪日志（Ctrl-C 退出）
```

## 出问题时

- 部署失败：服务器端 deploy.sh 拉取失败时不会动正在跑的服务，直接排查原因即可（常见：CI 还没跑完、服务器出网问题）。
- 新版本起不来：健康检查超时会自动打日志，先看日志定位；要先恢复服务就 `--rollback`。
- 公网验证失败但容器健康：多半是 Traefik / DNS / Cloudflare 层的问题，与本次部署无关，按网络问题排查。

## 红线

- 本仓库**公开**。服务器地址、账号、密码只能存在 `deploy/.deploy.env`，绝不能出现在任何会提交的文件或对话可见的命令行里。
- 永远不要在服务器上手动 `docker compose down -v` 或删 `data/` / `minio-data/` —— 用户数据无价，脚本的设计就是绝不碰数据。
