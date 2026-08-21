# ---- 1) 构建前端 ----------------------------------------------------------
FROM node:22-alpine AS web-build
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- 2) 只装后端的生产依赖 -------------------------------------------------
FROM node:22-alpine AS server-deps
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ---- 3) 运行时 ------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    DATA_DIR=/app/data

WORKDIR /app

# 后端源码与依赖；web/dist 的相对位置要与仓库一致，服务端据此托管前端
COPY --from=server-deps /build/server/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/src ./server/src
# 运维脚本（把本地附件搬进 MinIO、清点历史上传）要能在容器里跑：
#   docker compose run --rm loop-im node scripts/migrate-uploads-to-minio.mjs
COPY scripts ./scripts
COPY --from=web-build /build/web/dist ./web/dist

# 以非 root 运行，数据目录交给挂载卷
RUN mkdir -p /app/data/uploads && chown -R node:node /app
USER node

EXPOSE 4000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
