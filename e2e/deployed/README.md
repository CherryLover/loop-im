# 针对「已部署环境」的浏览器验证

这一组用 Playwright 打**已经跑起来的部署**，在真实 Chromium 里一步步点，
覆盖 `docs/测试用例.md` 里那些单测和 jsdom 够不着的地方：

- 图片是不是真的从对象存储经 `/uploads` 回源**渲染出来**（`naturalWidth > 0`，不是坏图标）
- PDF 是不是真的**不内联**，而是文件卡片
- 两个真实浏览器之间的**未读徽标**与**已读回执**
- 个人资料弹窗、头像上传、主题切换与**刷新后的记忆**（`localStorage` 真实读写）
- AI 管理二级页、原始对话展开、三个开关的 `role="switch"` 可访问性
- 移动端底部标签栏与列表 / 详情切换（真实视口，桌面侧栏隐藏）

和上一层 `e2e/` 的区别：那一份每次开临时数据库、自己拉起 server，跑的是
「代码对不对」；这一份不起服务，跑的是「**这套部署对不对**」。

## 跑之前

会往目标环境**写数据**（建群、发消息、加联系人、停用又恢复账号），
所以只指向测试环境，别打生产。

需要 4 个账号：1 个管理员 + 3 个普通成员。第三方成员用来验「不在群里的人
拿不到附件、搜不到消息」这类边界，少一个人就验不了。本地可以用 `.env` 里的
`ADMIN_*` 和 `DEMO_USERS` 造出来。

```bash
cd e2e && npm install        # 首次

BASE=http://127.0.0.1:4000 \
ADMIN_EMAIL=admin@example.com   ADMIN_PASSWORD=...  \
M1_EMAIL=jia@example.com        M1_PASSWORD=...     M1_NAME=测试甲 \
M2_EMAIL=yi@example.com         M2_PASSWORD=...     M2_NAME=测试乙 \
M3_EMAIL=bing@example.com       M3_PASSWORD=...     M3_NAME=测试丙 \
npm run test:deployed --prefix ..
```

`M*_NAME` 是界面上显示的名字，用来在联系人 / 建群名单里点人，要和账号对得上。

截图落在 `deployed/.artifacts/shots/`，失败的 trace 在 `deployed/.artifacts/traces/`，
两者都不进 git。

## 一起用的还有

- `scripts/verify-deployment.sh` —— 同一套部署的**接口层**验证（响应头、鉴权、
  限流边界这些浏览器里看不出来的）。两个互补：那个验协议，这个验人看到的东西。
- `docs/测试用例.md` §5 —— 这两样都覆盖不到、只能人工的清单（真实系统通知、
  真机移动端、真实大模型调用）。
