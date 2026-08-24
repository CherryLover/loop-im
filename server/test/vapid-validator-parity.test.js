/**
 * VAPID subject 的校验有**两份**实现，这条用例守的是它们之间那个不变量。
 *
 * 两份分别是：
 *   - src/vapid-config.js 的 validateSubject —— 启动自检用，规则更全
 *     （IPv6、单标签主机名、.internal/.lan/.corp/... 一串后缀）
 *   - src/web-push.js 的 validateVapidSubject —— 每次发推送前再挡一道
 *
 * 为什么不合成一份：两边的返回形状不同（前者 {ok,reason,detail,hint}，
 * 后者 {ok,reason,message}），各自都有一整套已经绿的用例，合并要动很大一片。
 * 判断是：**保留两份，但把危险方向钉死。**
 *
 * 危险方向只有一个 —— 协议层比配置层严。那样启动自检说「推送已启用」，
 * 而每一条推送都在发出前被自己拦掉：日志里只有零星 warn，用户看到的是
 * 「开关开着但永远收不到」。反过来（配置层更严）只会让服务在启动时就明确拒绝，
 * 那是能当场发现的。
 *
 * 所以断言是**单向包含**：凡是 web-push 拒的，vapid-config 必须也拒。
 * 谁往 web-push 里加了一条新规则却没同步到 vapid-config，这里立刻红。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateVapidSubject } from '../src/web-push.js';
import { validateSubject } from '../src/vapid-config.js';

// 覆盖两边各自声称会拦的所有形态，外加几个必须放行的。
const SUBJECTS = [
  // —— 应当放行 ——
  'mailto:admin@im.example.com',
  'mailto:ops@example.com',              // 生成脚本的默认占位值，必须能过
  'https://im.example.com',
  'https://im.example.com/contact',
  // —— 不可路由 ——
  'mailto:admin@localhost',
  'mailto:admin@localhost.localdomain',
  'mailto:a@box.local',
  'mailto:a@svc.internal',
  'mailto:a@foo.test',
  'mailto:a@foo.invalid',
  'mailto:a@foo.example',
  'mailto:a@host.lan',
  'mailto:a@host.corp',
  'mailto:a@host.home',
  'mailto:a@host.intranet',
  'mailto:a@intranet',                   // 单标签
  'mailto:a@192.168.1.10',
  'mailto:a@10.0.0.1',
  'https://localhost',
  'https://127.0.0.1',
  'https://[::1]',
  'https://intranet',
  // —— 形状本身不合法 ——
  '',
  '   ',
  'admin@im.example.com',                // 没有 scheme
  'http://im.example.com',               // 明文
  'mailto:',
  'mailto:admin',                        // 没有 @
  'mailto:@example.com',                 // 没有 local part
  'mailto:admin@',                       // 没有域名
  'mailto:a@x.com,b@y.com',              // 两个地址
  'ftp://im.example.com',
  null,
  undefined,
  12345,
];

describe('VAPID subject 校验 · 两份实现之间的单向包含', () => {
  for (const subject of SUBJECTS) {
    test(`${JSON.stringify(subject)}`, () => {
      const protocolLayer = validateVapidSubject(subject);
      const configLayer = validateSubject(subject);

      if (!protocolLayer.ok) {
        assert.equal(
          configLayer.ok, false,
          `web-push.js 拒了 ${JSON.stringify(subject)}，但 vapid-config.js 放行了。\n`
          + '后果：启动自检说「推送已启用」，而每条推送都在发出前被自己拦掉 —— '
          + '开关开着、日志里只有零星 warn、用户永远收不到。\n'
          + '往 web-push.js 加规则时，vapid-config.js 要同步。',
        );
      }
    });
  }

  test('放行的那几个确实两边都放行（否则上面的单向断言可能是空转）', () => {
    for (const ok of ['mailto:admin@im.example.com', 'mailto:ops@example.com', 'https://im.example.com']) {
      assert.equal(validateVapidSubject(ok).ok, true, `web-push.js 不该拒 ${ok}`);
      assert.equal(validateSubject(ok).ok, true, `vapid-config.js 不该拒 ${ok}`);
    }
  });
});
