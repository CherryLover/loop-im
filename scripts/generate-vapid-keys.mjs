#!/usr/bin/env node
/**
 * 生成一对 VAPID 密钥（Web Push 用），输出三行能直接粘进 .env 的内容。
 *
 *   node scripts/generate-vapid-keys.mjs
 *   node scripts/generate-vapid-keys.mjs --subject mailto:admin@im.example.com
 *   node scripts/generate-vapid-keys.mjs --help
 *
 * 容器里跑（部署时的典型用法，不需要在宿主机装 Node）：
 *
 *   docker compose run --rm loop-im node scripts/generate-vapid-keys.mjs
 *
 * ── 输出为什么分两条流 ───────────────────────────────────────────────
 * **stdout 只有那三行**，别的话（包括警告）全走 stderr。这样可以直接追加进配置文件：
 *
 *   docker compose run --rm loop-im node scripts/generate-vapid-keys.mjs >> .env
 *
 * 追加完记得把 .env 里原来那三行空的删掉 —— 同名变量后面的覆盖前面的，
 * 顺序反了就等于没配。
 *
 * ── 零依赖 ───────────────────────────────────────────────────────────
 * 只用 Node 原生 crypto，不引 web-push 那套包。VAPID 密钥就是一对普通的 P-256 密钥，
 * 加上一个约定的编码方式（公钥 = 未压缩点 base64url，私钥 = 私钥标量 base64url），
 * 没有任何需要第三方库的地方。
 *
 * ── 生成和校验是同一套口径 ───────────────────────────────────────────
 * 末尾会拿 server/src/vapid-config.js 里**服务端启动时用的那个校验函数**
 * 把刚生成的这一对再验一遍。这不是走过场：如果哪天编码方式改了一边没改另一边，
 * 结果就是「按文档生成的密钥被自己的服务拒了」，而报错会指向配置错误、
 * 让人怎么也想不到是生成脚本的问题。验不过就非零退出，不输出任何东西。
 *
 * ── ⚠️ 换公钥 = 所有已有订阅立即失效 ─────────────────────────────────
 * 公钥是在浏览器 subscribe() 那一刻绑进订阅里的。换了之后，老订阅推过去会被
 * 推送服务拒掉，而**没有任何办法从服务端把它们迁移过来** —— 必须让每个用户
 * 在每台设备上重新打开一次通知开关。所以这个脚本只在**第一次部署**时跑；
 * 已经在用的环境别手滑重跑一遍。
 */
import { generateKeyPairSync } from 'node:crypto';
import { readVapidConfig, validateSubject } from '../server/src/vapid-config.js';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** 没给 --subject 时填的占位值。它本身能过校验（example.com 是真域名），但显然不是你的域名。 */
const PLACEHOLDER_SUBJECT = 'mailto:admin@example.com';

if (has('--help') || has('-h')) {
  console.log(String.raw`
生成一对 VAPID 密钥，输出三行 .env 配置。

  --subject <值>   VAPID_SUBJECT 的值，必须是真实域名的 mailto: 邮箱或 https:// 网址。
                   不给就填占位的 ${PLACEHOLDER_SUBJECT}，你得自己改掉。
  --help           看这段

stdout 只有那三行配置，提示和警告都走 stderr，所以可以直接 >> .env。

⚠️ 换公钥 = 所有已有订阅立即失效，用户必须在每台设备上重新打开通知开关。
   这个脚本只在第一次部署时跑。
`.trim());
  process.exit(0);
}

const note = (line) => process.stderr.write(`${line}\n`);

// ── 1. subject 先验，别等密钥都生成完了才告诉人家参数写错了 ────────────────
const subject = valueOf('--subject') ?? PLACEHOLDER_SUBJECT;
const checked = validateSubject(subject);
if (!checked.ok) {
  note(`✗ --subject 不合法（${checked.reason}）`);
  note(`  ${checked.detail}`);
  note(`  ${checked.hint}`);
  process.exit(1);
}

// ── 2. 生成 ────────────────────────────────────────────────────────────────
// prime256v1 是 P-256 在 OpenSSL 里的名字，同一条曲线。RFC 8292 只允许这一条。
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });

// 公钥 = 0x04 || X || Y（未压缩点，65 字节）。浏览器 subscribe() 的
// applicationServerKey 只认这个格式，不能用 SPKI / PEM 那些。
const publicKeyB64 = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(jwk.x, 'base64url'),
  Buffer.from(jwk.y, 'base64url'),
]).toString('base64url');

// 私钥 = 私钥标量 d，32 字节。JWK 里本来就是 base64url，直接用。
const privateKeyB64 = jwk.d;

// ── 3. 拿服务端那套校验回验一遍，口径对不上就别输出 ─────────────────────────
const verdict = readVapidConfig({
  VAPID_PUBLIC_KEY: publicKeyB64,
  VAPID_PRIVATE_KEY: privateKeyB64,
  VAPID_SUBJECT: subject,
});
if (!verdict.enabled) {
  note('✗ 生成出来的密钥没能通过服务端的启动自检，这是脚本自己的 bug，不是你的配置问题。');
  note(`  reason: ${verdict.reason}`);
  note(`  ${verdict.detail}`);
  note('  请带着这段输出提个 issue；先别用这对密钥。');
  process.exit(1);
}

// ── 4. 三行配置走 stdout，别的全走 stderr ──────────────────────────────────
console.log(`VAPID_PUBLIC_KEY=${publicKeyB64}`);
console.log(`VAPID_PRIVATE_KEY=${privateKeyB64}`);
console.log(`VAPID_SUBJECT=${subject}`);

note('');
note('✓ 已生成，并通过了服务端启动自检用的那套校验。把上面三行填进 deploy/.env，重启即可。');
note('');
note('  ⚠️ VAPID_PRIVATE_KEY 是密钥：只写进 .env（.env 不进 git），别贴进聊天、工单或截图。');
note('  ⚠️ 换公钥 = 所有已有订阅立即失效，用户必须在每台设备上重新打开一次通知开关。');
note('     这个脚本只在第一次部署时跑，已经在用的环境别重跑。');
if (subject === PLACEHOLDER_SUBJECT) {
  note('');
  note(`  ⚠️ VAPID_SUBJECT 现在是占位值 ${PLACEHOLDER_SUBJECT}，请改成你们真实域名的邮箱。`);
  note('     苹果的推送服务对这一项校验很严，写成 localhost / 内网域名会被 403 BadJwtToken 拒掉，');
  note('     而症状是「安卓收得到、iPhone 一条都收不到」，很难往这里想。');
}
note('');
note('  验证是否生效：重启后 `docker compose logs loop-im | grep -E "push\\.(enabled|disabled)"`。');
