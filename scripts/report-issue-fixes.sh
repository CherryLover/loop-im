#!/usr/bin/env bash
#
# 把 12 个 issue 的修复状态回报到 GitHub：逐条评论，已完成的关闭。
#
#   ./scripts/report-issue-fixes.sh            # 预演，只打印要做什么，不改动任何东西
#   ./scripts/report-issue-fixes.sh --apply    # 真正提交评论并关闭
#   ./scripts/report-issue-fixes.sh --followups # 另外开 3 个后续 issue（见报告最后一节）
#
# 需要本机装好并登录过 gh：  gh auth login
set -euo pipefail

REPO="${REPO:-CherryLover/loop-im}"
COMMIT="${COMMIT:-7aeeafa}"
REPORT="https://github.com/${REPO}/blob/main/docs/issue-fixes-2026-08.md"
APPLY=false

case "${1:-}" in
  --apply) APPLY=true ;;
  --followups) MODE=followups ;;
  --help|-h) sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

# 预演不需要 gh，真正提交才需要
require_gh() {
  command -v gh >/dev/null || { echo "需要 gh CLI 并已登录（gh auth login）：https://cli.github.com" >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "gh 未登录，先执行：gh auth login" >&2; exit 1; }
}

# 每条 issue 的修复说明：编号|是否可关闭|一句话根因|一句话修法|回归用例
FIXES=$(cat <<'ROWS'
1|open|每条消息都无条件调用 learnAbout()，开关只影响回复不影响学习，且消息没有可见性记录，改开关会追溯生效|写库时按会话类型、AI 是否在群、静默读取开关与 @ 规则定档 messages.ai_visible；画像学习、回复上下文、原始对话查询都只读可见消息|server/test/issue-1.test.js
2|close|token 只带 id、角色与过期时间，没有可撤销的版本标记|新增 users.auth_version，改密码时 +1 让此前签发的 token 全部作废，改密码的设备换发新凭据|server/test/issue-2.test.js
3|close|复选框只是装饰，前端始终写 localStorage、后端始终签 15 天|不勾选时前端写 sessionStorage、后端只签 1 天有效期，勾选与否共用同一套换发逻辑|server/test/issue-3.test.js、web/src/lib/issue-3.test.ts
4|close|列表与详情的开合状态放在 ChatPage 内部，切换底部标签时组件重新挂载即丢失|状态提升到 AppShell，「去聊天」与「建群」统一走 selectConversation|e2e/issue-4.spec.ts
5|close|同 #4：建群时 ChatPage 重新挂载，手机端停在会话列表|与 #4 合并为同一套受控机制，建群成功直接进入新群|e2e/issue-5.spec.ts、web/src/issue-5.test.tsx
6|close|退出只清本地 token，服务端没有 logout 接口，在线与否只看 90 秒心跳窗口|新增 sessions 表与 POST /api/auth/logout：结束本次会话，该账号无其他设备在线时立刻置离线并广播|server/test/issue-6.test.js、web/src/issue-6.test.tsx
7|open|界面把「已读」写死在自己的气泡里，数据层根本没有已读概念|文案改为「已发送」，并加接口用例约束不得返回伪造的已读字段|server/test/issue-7.test.js、web/src/issue-7.test.tsx
8|close|保存成功与测试结果是两个互不清理的状态|合并成单一 feedback 状态，切换供应商、改凭据、改开关都会清掉过期反馈|web/src/pages/issue-8.test.tsx
9|close|multer 的 File too large 被兜底处理成 500 原样返回，前端也没有本地校验|统一 413 与中文文案，前后端共用同一常量，选图、粘贴、头像三处上传前本地拦截，界面标注上限|server/test/issue-9.test.js、web/src/issue-9.test.tsx
10|close|开关按钮只有装饰用的空 span 与 aria-pressed，名称是旁边的纯文本|改为 role="switch" + aria-checked，用 aria-labelledby / aria-describedby 关联名称与说明|web/src/pages/issue-10.test.tsx
11|close|Toast 固定右上角且接收指针事件，390 宽视口下正好压住「建群」按钮|Toast 不再接收点击，移动端移到底部安全区域并限制最大宽度|e2e/issue-11.spec.ts
12|close|复用固定数据目录且跑完不清理，第二次运行接着上一轮的库跑；端口固定；用例之间有依赖|每次运行独占临时数据目录与空闲端口、跑完清理，用例数据带时间戳且互不依赖|全套 e2e 连续三次通过
ROWS
)

# #1 / #7 保留开启：修复已合并，但 issue 里还有一项建议没做完
REMAINING_1='仍未做的一项：`ai_visible` 只对新消息生效，开关关闭前已经写进画像的内容还在库里。issue 的建议 6（清理/重建被污染的画像）需要一个管理端入口，建议单独开 issue 跟踪。因此这条先不关闭。'
REMAINING_7='仍未做的一项：真正的已读回执（成员已读位置、上报接口、SSE 事件、前端上报）是一轮独立的功能开发，本次只消除了「凭空显示已读」这个错误呈现。要不要做完整已读由你决定，因此这条先不关闭。'

comment_body() {
  local num="$1" cause="$2" fix="$3" tests="$4" extra="$5"
  printf '已修复并合入 `main`（%s）。\n\n' "$COMMIT"
  printf '**根因**：%s\n\n' "$cause"
  printf '**修法**：%s\n\n' "$fix"
  printf '**回归用例**：`%s`\n\n' "$tests"
  [ -n "$extra" ] && printf '%s\n\n' "$extra"
  printf '全量回归：后端 80、前端 63、端到端 12，连续三次通过；CI 与 Docker 工作流均绿，镜像已发布。\n'
  printf '完整报告：%s\n' "$REPORT"
}

if [ "${MODE:-}" = "followups" ]; then
  require_gh
  echo "▸ 创建 3 个后续 issue"
  gh issue create --repo "$REPO" --title "已读回执：把「已发送」做成真正的已读状态" \
    --body "承接 #7。当前只消除了凭空显示「已读」的错误呈现，文案改为「已发送」。

要做完整已读需要：
- 数据层记录每个成员在每个会话的已读位置
- 客户端在消息进入视口时上报
- 通过 SSE 广播已读变化
- 气泡按「已发送 / 已读」两态渲染，群聊显示已读人数

参考：docs/issue-fixes-2026-08.md"
  gh issue create --repo "$REPO" --title "AI 画像：提供重置/重建入口，清理关闭静默读取前写入的内容" \
    --body "承接 #1。\`messages.ai_visible\` 只对新消息生效，开关关闭前已写进 \`ai_profiles\` 的内容仍然存在。

要做：
- AI 管理页提供「重置这个人的画像」与「按可见消息重建」
- 重建时只读 \`ai_visible = 1\` 的消息
- 记录一次重建的时间，便于排查

参考：docs/issue-fixes-2026-08.md"
  gh issue create --repo "$REPO" --title "同浏览器多标签：让每个标签持有独立会话" \
    --body "承接 #6。多个标签共享 localStorage 里的同一个 token，也就是同一条 session，一个标签退出会让其他标签一起失效。

要做：
- 每个标签独立签发 token（或在现有 session 下再分设备标识）
- 退出只结束当前标签的会话
- 在线状态按「该账号是否还有任一会话活跃」判定（这部分已经是现状）

参考：docs/issue-fixes-2026-08.md"
  exit 0
fi

while IFS='|' read -r num action cause fix tests; do
  [ -z "$num" ] && continue
  extra=""
  [ "$num" = "1" ] && extra="$REMAINING_1"
  [ "$num" = "7" ] && extra="$REMAINING_7"
  body="$(comment_body "$num" "$cause" "$fix" "$tests" "$extra")"

  if $APPLY; then
    require_gh
    echo "▸ #$num 评论中…"
    gh issue comment "$num" --repo "$REPO" --body "$body"
    if [ "$action" = "close" ]; then
      gh issue close "$num" --repo "$REPO" --reason completed
      echo "  已关闭 #$num"
    else
      echo "  #$num 保留开启（还有未完成项）"
    fi
  else
    echo "══════ #$num  →  $([ "$action" = close ] && echo 评论并关闭 || echo 仅评论，保留开启)"
    echo "$body"
    echo
  fi
done <<< "$FIXES"

$APPLY || { echo "以上为预演。确认无误后加 --apply 真正提交，或用 --followups 另开 3 个后续 issue。"; }
