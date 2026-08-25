#!/usr/bin/env bash
#
# 从开发机一键更新线上：SSH 到服务器，执行那边的 deploy.sh（先拉新镜像、再停旧容器、
# 后起新容器，数据目录不动），最后从公网侧验证一次健康接口。
#
#   ./remote-deploy.sh              # 更新到 latest
#   ./remote-deploy.sh v1.2.0       # 部署指定版本
#   ./remote-deploy.sh --rollback   # 回滚到上一次成功部署的版本
#   ./remote-deploy.sh --status     # 只看服务器上的容器状态
#   ./remote-deploy.sh --logs       # 跟踪服务器日志（Ctrl-C 退出）
#
# 连接信息一律来自同目录的 .deploy.env（不进 git，模板见 .deploy.env.example）。
# 本仓库是公开的：服务器地址、账号、密码绝不能写进任何会提交的文件 —— 包括这个脚本。
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -f .deploy.env ] || die "缺少 deploy/.deploy.env（连接信息不进 git）。照着 .deploy.env.example 抄一份填好再来。"
# shellcheck disable=SC1091
. ./.deploy.env

: "${DEPLOY_HOST:?}" "${DEPLOY_USER:?}" "${DEPLOY_DIR:?}" || die ".deploy.env 里 DEPLOY_HOST / DEPLOY_USER / DEPLOY_DIR 都是必填"
DEPLOY_PORT="${DEPLOY_PORT:-22}"

# 有密码走 sshpass，没配密码就交给 ssh 自己（密钥 / agent / 交互输入）。
SSH=(ssh -p "$DEPLOY_PORT" -o StrictHostKeyChecking=accept-new "$DEPLOY_USER@$DEPLOY_HOST")
if [ -n "${DEPLOY_PASSWORD:-}" ]; then
  command -v sshpass >/dev/null 2>&1 || die "配了 DEPLOY_PASSWORD 但没装 sshpass（brew install sshpass，或删掉密码改用密钥）"
  SSH=(sshpass -p "$DEPLOY_PASSWORD" "${SSH[@]}")
fi

remote() { "${SSH[@]}" "cd '$DEPLOY_DIR' && $*"; }

verify_health() {
  [ -n "${HEALTH_URL:-}" ] || return 0
  # 给 Traefik / 容器一点起身时间；deploy.sh 内部已经等过本机健康检查，
  # 这里是从公网侧再确认一遍「用户真的访问得到」。
  local i
  for i in 1 2 3 4 5 6; do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      ok "公网验证通过：$HEALTH_URL"
      return 0
    fi
    sleep 3
  done
  warn "公网侧连不上 $HEALTH_URL —— 容器可能还在起身，稍等再手动看一眼；不行就 ./remote-deploy.sh --rollback"
  return 1
}

case "${1:-}" in
  --status)
    remote "./deploy.sh --status"
    ;;
  --logs)
    # -t 要一个真终端，跟踪日志才能 Ctrl-C 干净退出。
    "${SSH[@]}" -t "cd '$DEPLOY_DIR' && ./deploy.sh --logs"
    ;;
  --rollback)
    bold "▸ 回滚线上（$DEPLOY_HOST）"
    remote "./deploy.sh --rollback"
    verify_health
    ;;
  --help|-h)
    sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    bold "▸ 更新线上（$DEPLOY_HOST · tag=${1:-latest}）"
    remote "./deploy.sh ${1:-}"
    verify_health
    ;;
esac
