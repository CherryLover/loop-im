#!/usr/bin/env bash
#
# Loop IM 一键部署 / 更新。
#
#   ./deploy.sh              # 拉取 .env 里指定的 tag（默认 latest）并重启
#   ./deploy.sh v1.2.0       # 部署指定版本
#   ./deploy.sh --rollback   # 回到上一次成功部署的版本
#   ./deploy.sh --status     # 只看当前状态，不做任何改动
#   ./deploy.sh --logs       # 跟踪日志
#
# 所有数据都在本脚本同级的 data/ 目录里，脚本不会碰它。
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

COMPOSE_FILE="docker-compose.yml"
ENV_FILE=".env"
DATA_DIR="data"
STATE_FILE=".last-deployed-tag"
HEALTH_TIMEOUT=90

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

usage() {
  cat <<'USAGE'
Loop IM 一键部署 / 更新

  ./deploy.sh              拉取 .env 里指定的 tag（默认 latest）并重启
  ./deploy.sh v1.2.0       部署指定版本
  ./deploy.sh --rollback   回到上一次成功部署的版本
  ./deploy.sh --status     只看当前状态，不做任何改动
  ./deploy.sh --logs       跟踪日志

所有数据都在本脚本同级的 data/ 目录里，脚本不会碰它。
USAGE
}

require_tools() {
  command -v docker >/dev/null 2>&1 || die "没找到 docker，请先安装 Docker Engine"
  docker compose version >/dev/null 2>&1 || die "没找到 docker compose 插件（需要 Docker Compose v2）"
  docker info >/dev/null 2>&1 || die "无法连接 Docker daemon：确认服务已启动，且当前用户在 docker 组里"
}

require_files() {
  [ -f "$COMPOSE_FILE" ] || die "缺少 $COMPOSE_FILE（本脚本要和它放在同一个目录）"
  if [ ! -f "$ENV_FILE" ]; then
    [ -f ".env.example" ] || die "缺少 $ENV_FILE，且没有 .env.example 可参考"
    cp .env.example "$ENV_FILE"
    warn "已从 .env.example 生成 $ENV_FILE，请填好下面几项后重新运行："
    info "  JWT_SECRET      （生成：openssl rand -hex 32）"
    info "  ADMIN_EMAIL / ADMIN_PASSWORD  （第一个管理员账号）"
    exit 1
  fi
}

# .env 里必须有值的项，缺一不可
require_env() {
  local missing=()
  for key in JWT_SECRET ADMIN_EMAIL ADMIN_PASSWORD; do
    local value
    value="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
    [ -n "${value//[[:space:]]/}" ] || missing+=("$key")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    die "$ENV_FILE 里这些必填项还是空的：${missing[*]}"
  fi
}

read_env() {
  local key="$1" fallback="${2:-}"
  local value=""
  [ -f "$ENV_FILE" ] && value="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  printf '%s' "${value:-$fallback}"
}

prepare_data_dir() {
  mkdir -p "$DATA_DIR/uploads"
  # 容器里以 node 用户（uid 1000）运行，宿主目录要让它写得进去
  if [ "$(id -u)" = "0" ]; then
    chown -R 1000:1000 "$DATA_DIR"
  elif [ ! -w "$DATA_DIR" ]; then
    warn "$DATA_DIR 当前用户不可写，若容器启动后报权限错误，执行：sudo chown -R 1000:1000 $DATA_DIR"
  fi
  ok "数据目录就绪：$(pwd)/$DATA_DIR （SQLite 库与图片附件都在这里）"
}

wait_for_health() {
  local port host url deadline
  port="$(read_env HOST_PORT 4000)"
  host="$(read_env BIND_ADDRESS 127.0.0.1)"
  [ "$host" = "0.0.0.0" ] && host="127.0.0.1"
  url="http://${host}:${port}/api/health"
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))

  info "等待服务就绪：$url"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      ok "服务已就绪：$url"
      return 0
    fi
    if [ -z "$(compose ps -q loop-im)" ]; then
      break
    fi
    sleep 2
  done
  return 1
}

deploy() {
  local tag="$1"
  bold "▸ Loop IM 部署 · tag=${tag}"
  require_tools
  require_files
  require_env
  prepare_data_dir

  export LOOP_IM_TAG="$tag"

  info "拉取镜像 $(read_env LOOP_IM_IMAGE ghcr.io/cherrylover/loop-im):${tag}"
  if ! compose pull; then
    warn "拉取失败，常见原因："
    info "  · 这个 tag 还没发布 —— 到 GitHub Actions 看 Docker 工作流是否跑完"
    info "  · 镜像包是私有的 —— 在 GitHub Packages 里把它设为 public，"
    info "    或先执行：echo <GITHUB_TOKEN> | docker login ghcr.io -u <用户名> --password-stdin"
    info "  · 服务器访问不了 ghcr.io —— 检查出网或代理"
    die "拉取镜像失败，未改动正在运行的服务"
  fi

  info "停止旧容器并启动新容器"
  compose up -d --remove-orphans

  if wait_for_health; then
    printf '%s\n' "$tag" > "$STATE_FILE"
    docker image prune -f >/dev/null 2>&1 || true
    ok "部署完成"
    printf '\n'
    compose ps
    printf '\n'
    info "最近日志（Ctrl-C 退出不影响服务）："
    compose logs --tail 20
  else
    warn "健康检查超时，下面是容器日志："
    compose logs --tail 60
    die "部署失败。可用 ./deploy.sh --rollback 回到上一个版本"
  fi
}

rollback() {
  [ -f "$STATE_FILE" ] || die "没有上一次成功部署的记录，请显式指定版本：./deploy.sh <tag>"
  local previous
  previous="$(cat "$STATE_FILE")"
  bold "▸ 回滚到 ${previous}"
  deploy "$previous"
}

case "${1:-}" in
  --status)
    require_tools; require_files
    compose ps
    ;;
  --logs)
    require_tools; require_files
    compose logs -f --tail 100
    ;;
  --rollback)
    require_tools; require_files; rollback
    ;;
  --help|-h)
    usage
    ;;
  "")
    require_files
    deploy "$(read_env LOOP_IM_TAG latest)"
    ;;
  *)
    deploy "$1"
    ;;
esac
