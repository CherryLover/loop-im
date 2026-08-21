#!/usr/bin/env bash
#
# 对一个**跑起来的**部署做接口级验证，覆盖 docs/测试用例.md 里
# 标着「只能人工」的那批运维项（TC-OPS / TC-ATTACH 组）。
#
# 这些是自动化测试够不着的部分：单测里的对象存储是内存实现，
# SigV4 只对过 AWS 官方向量，附件回源的响应头也没有真实 HTTP 栈参与。
# 切换存储配置、升级依赖、换机器部署之后，跑一遍这个。
#
# 用法：
#   ./scripts/verify-deployment.sh                      # 默认打 127.0.0.1:4000
#   BASE=http://im.example.com ./scripts/verify-deployment.sh
#
# 前置：部署里存在下面这三个账号（本地可用 .env 的 ADMIN_* 与 DEMO_USERS 造）。
# 需要三个身份是因为「非成员拿不到附件」这类用例，少一个人就验不了。
#   ADMIN_EMAIL / ADMIN_PASSWORD    管理员，用来建群
#   MEMBER_EMAIL / MEMBER_PASSWORD  群成员
#   OUTSIDER_EMAIL / OUTSIDER_PASSWORD  不在群里的人
#
# 退出码：全过 0，有失败 1。
set -uo pipefail

BASE=${BASE:-http://127.0.0.1:4000}
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@example.com}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-}
MEMBER_EMAIL=${MEMBER_EMAIL:-jia@example.com}
MEMBER_PASSWORD=${MEMBER_PASSWORD:-}
OUTSIDER_EMAIL=${OUTSIDER_EMAIL:-yi@example.com}
OUTSIDER_PASSWORD=${OUTSIDER_PASSWORD:-}

if [ -z "$ADMIN_PASSWORD" ] || [ -z "$MEMBER_PASSWORD" ] || [ -z "$OUTSIDER_PASSWORD" ]; then
  echo "请先设好三个账号的密码，例如："
  echo "  ADMIN_PASSWORD=... MEMBER_PASSWORD=... OUTSIDER_PASSWORD=... $0"
  exit 2
fi

for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "缺少 $tool"; exit 2; }
done

D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 — 期望 [$3] 实得 [$2]"; fi; }
login() {
  curl -s -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" | jq -r .token
}

echo "=============================================="
echo " Loop IM 部署验证 · $BASE"
echo "=============================================="

# 样本文件：图片用真实 PNG 字节（服务端按 magic number 判定，伪造扩展名没用）
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$D/tiny.png"
printf '%%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF\n' > "$D/doc.pdf"
printf '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' > "$D/evil.svg"
printf '<html><body><script>alert(document.cookie)</script></body></html>' > "$D/evil.html"

echo; echo "── TC-OPS-13 健康检查"
chk "GET /api/health" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")" "200"
chk "返回 ok" "$(curl -s "$BASE/api/health" | jq -r .ok)" "true"

echo; echo "── TC-AUTH-01/02 登录"
TA=$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
TB=$(login "$MEMBER_EMAIL" "$MEMBER_PASSWORD")
TC=$(login "$OUTSIDER_EMAIL" "$OUTSIDER_PASSWORD")
[ ${#TA} -gt 20 ] && ok "管理员登录" || bad "管理员登录失败"
[ ${#TB} -gt 20 ] && ok "成员登录"   || bad "成员登录失败"
[ ${#TC} -gt 20 ] && ok "第三方登录" || bad "第三方登录失败"
chk "错误密码被拒" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"definitely-wrong\"}")" "401"

echo; echo "── TC-GROUP-01 建群（管理员 + 成员，第三方不在群里）"
MEMBER_ID=$(curl -s "$BASE/api/users" -H "authorization: Bearer $TA" \
  | jq -r --arg e "$MEMBER_EMAIL" '.users[]|select(.email==$e)|.id')
CONV=$(curl -s -X POST "$BASE/api/conversations/group" -H "authorization: Bearer $TA" \
  -H 'content-type: application/json' \
  -d "{\"title\":\"部署验证 $(date +%H%M%S)\",\"memberIds\":[\"$MEMBER_ID\"]}" | jq -r .conversation.id)
[ -n "$CONV" ] && [ "$CONV" != "null" ] && ok "建群成功 $CONV" || { bad "建群失败"; echo "后续用例依赖这个群，中止。"; exit 1; }

echo; echo "── TC-OPS-01/02 附件落到对象存储，且浏览器不直连"
UP=$(curl -s -X POST "$BASE/api/uploads" -H "authorization: Bearer $TB" -F "file=@$D/tiny.png")
IMGURL=$(echo "$UP" | jq -r .url)
chk "图片被识别为 image" "$(echo "$UP" | jq -r .kind)" "image"
echo "     storage=$(echo "$UP" | jq -r .storage)  url=$IMGURL"
case "$IMGURL" in
  /uploads/*) ok "附件地址是同源回源路径，不是预签名 / 直连 URL" ;;
  *)          bad "附件地址不是 /uploads/ 回源：$IMGURL" ;;
esac
if echo "$IMGURL" | grep -qiE "minio|:9000|X-Amz-Signature"; then
  bad "地址里出现了对象存储的主机名或签名参数 —— 安全响应头会全部丢掉"
else
  ok "地址里没有对象存储主机名 / 签名参数"
fi

curl -s -X POST "$BASE/api/conversations/$CONV/messages" -H "authorization: Bearer $TB" \
  -H 'content-type: application/json' -d "{\"body\":\"部署验证图片 ![img]($IMGURL)\"}" -o /dev/null
ok "已把图片发进群（建立附件归属）"

echo; echo "── TC-ATTACH-10/11/13 附件下载鉴权"
chk "群成员下载 200" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$IMGURL" -H "authorization: Bearer $TB")" "200"
chk "群主下载 200"   "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$IMGURL" -H "authorization: Bearer $TA")" "200"
chk "未登录 401"     "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$IMGURL")" "401"
chk "非成员 404"     "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$IMGURL" -H "authorization: Bearer $TC")" "404"
GHOST=/uploads/00000000-0000-0000-0000-000000000000.png
chk "不存在的附件也 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$GHOST" -H "authorization: Bearer $TC")" "404"
# 两种 404 必须逐字相同：不一样就等于告诉调用方「这个 key 确实存在」，接口成了存在性探针
if [ "$(curl -s "$BASE$IMGURL" -H "authorization: Bearer $TC")" = "$(curl -s "$BASE$GHOST" -H "authorization: Bearer $TC")" ]; then
  ok "两种 404 的响应体逐字相同（不做存在性探针）"
else
  bad "两种 404 的响应体不同 —— 成了存在性探针"
fi

echo; echo "── TC-ATTACH-15 图片响应头"
HDR=$(curl -s -D - -o /dev/null "$BASE$IMGURL" -H "authorization: Bearer $TB")
echo "$HDR" | grep -qi "content-type: image/png"         && ok "Content-Type: image/png" || bad "图片 Content-Type 不对"
echo "$HDR" | grep -qi "x-content-type-options: nosniff" && ok "nosniff 在"              || bad "缺 nosniff"

echo; echo "── TC-ATTACH-02 非图片文件永远强制下载"
UP2=$(curl -s -X POST "$BASE/api/uploads" -H "authorization: Bearer $TB" -F "file=@$D/doc.pdf")
PDFURL=$(echo "$UP2" | jq -r .url)
chk "PDF 归到 file 档" "$(echo "$UP2" | jq -r .kind)" "file"
curl -s -X POST "$BASE/api/conversations/$CONV/messages" -H "authorization: Bearer $TB" \
  -H 'content-type: application/json' -d "{\"body\":\"部署验证文件 [doc.pdf]($PDFURL)\"}" -o /dev/null
HDR2=$(curl -s -D - -o /dev/null "$BASE$PDFURL" -H "authorization: Bearer $TB")
echo "$HDR2" | grep -qi "content-disposition: attachment"            && ok "Content-Disposition: attachment" || bad "缺强制下载头"
echo "$HDR2" | grep -qi "content-type: application/octet-stream"     && ok "octet-stream"                    || bad "Content-Type 不是 octet-stream"
echo "$HDR2" | grep -qi "content-security-policy.*default-src 'none'" && ok "CSP: default-src 'none'"        || bad "缺 CSP"
echo "$HDR2" | grep -qi "x-content-type-options: nosniff"            && ok "nosniff 在"                      || bad "缺 nosniff"

echo; echo "── TC-ATTACH-04/05/07 上传拦截"
chk "HTML 伪装成 png 被拒" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/uploads" \
  -H "authorization: Bearer $TB" -F "file=@$D/evil.html;filename=evil.png;type=image/png")" "400"
chk "SVG 被拒" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/uploads" \
  -H "authorization: Bearer $TB" -F "file=@$D/evil.svg;type=image/svg+xml")" "400"
head -c $((8*1024*1024+1)) /dev/urandom > "$D/big.bin"
chk "超过 8MB 被拒 413" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/uploads" \
  -H "authorization: Bearer $TB" -F "file=@$D/big.bin")" "413"

echo; echo "── TC-AI-01 群里 @Aria"
curl -s -X POST "$BASE/api/conversations/$CONV/messages" -H "authorization: Bearer $TB" \
  -H 'content-type: application/json' -d '{"body":"@Aria 帮我总结一下这个群"}' -o /dev/null
sleep 5
ARIA=$(curl -s "$BASE/api/conversations/$CONV/messages" -H "authorization: Bearer $TB" \
       | jq -r '[.messages[]|select(.isAI==true)]|length')
# 建群时 Aria 会先发一条欢迎，所以被 @ 之后应该至少有 2 条
[ "${ARIA:-0}" -ge 2 ] && ok "Aria 回复了（含建群欢迎共 $ARIA 条）" || bad "Aria 没回复（共 ${ARIA:-0} 条）"

echo; echo "── TC-SEARCH-02/03 搜索与权限"
chk "成员搜得到自己群里的消息" "$(curl -s -G "$BASE/api/messages/search" \
  --data-urlencode "q=部署验证图片" -H "authorization: Bearer $TB" | jq '.results|length>0')" "true"
chk "非成员搜不到"             "$(curl -s -G "$BASE/api/messages/search" \
  --data-urlencode "q=部署验证图片" -H "authorization: Bearer $TC" | jq '.results|length')" "0"

echo
echo "=============================================="
echo " 通过 $PASS · 失败 $FAIL"
echo "=============================================="
echo
echo "这个脚本验不到的，还得人工过一遍（见 docs/测试用例.md §5）："
echo "  · docker compose logs minio 里有没有 SignatureDoesNotMatch"
echo "  · 宿主机 curl http://127.0.0.1:9000 应该连不上（对象存储不该对外）"
echo "  · 真实系统通知、真机移动端、深色主题、个人资料弹窗"
echo "  · 真实大模型供应商调用（会计费）"

[ "$FAIL" -eq 0 ]
