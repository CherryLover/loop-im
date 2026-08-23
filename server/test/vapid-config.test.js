/**
 * VAPID 配置的启动自检。
 *
 * 这个文件要守住的核心，不是「合法配置能通过」，而是**配错的时候会不会安静地坏掉**：
 *
 * 1. 不配 / 配错都不能把服务弄崩 —— 推送是旁路，聊天不该为它陪葬；
 * 2. 不能出现「半开」—— 订阅存下来了、推送永远发不出去、界面上开关还亮着；
 * 3. VAPID_SUBJECT 写成 localhost / 内网域名必须在**启动时**就拦住。
 *    这一条是全块最值钱的：苹果的推送服务会用 403 BadJwtToken 拒掉这类 sub，
 *    而 FCM / Mozilla 是接受的 —— 症状是「本地和安卓全绿，上生产 iPhone 一条都收不到」，
 *    服务端只看到一个不解释原因的 403。等真机验才发现，成本高一个数量级。
 * 4. **生成脚本产出的密钥必须能通过校验。** 生成和校验是两套代码，
 *    口径一旦对不上，结果就是「照文档生成的密钥被自己的服务拒了」，
 *    而报错会指向配置错误，没人会想到去查生成脚本。所以这里真的跑一遍脚本，
 *    拿它的输出喂给校验函数。
 */
import './helpers.js';
import {
  VAPID_DISABLED_REASONS as R,
  __resetVapidConfigForTest,
  logVapidStatus,
  pushEnabled,
  readVapidConfig,
  validateSubject,
  vapidConfig,
} from '../src/vapid-config.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'scripts', 'generate-vapid-keys.mjs');

/** 现造一对合法密钥。刻意不复用生成脚本 —— 那是被测对象之一，不能同时当夹具。 */
function freshPair() {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
  const publicKey = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
  return { publicKey, privateKey: jwk.d };
}

const PAIR = freshPair();
const GOOD_SUBJECT = 'mailto:admin@im.example.com';

/** 一份完整合法的 env，用例在它基础上改一项来构造各种坏情况。 */
const goodEnv = (over = {}) => ({
  VAPID_PUBLIC_KEY: PAIR.publicKey,
  VAPID_PRIVATE_KEY: PAIR.privateKey,
  VAPID_SUBJECT: GOOD_SUBJECT,
  ...over,
});

/**
 * 收 logVapidStatus() 打出来的日志行。
 *
 * LOG_IN_TEST=1 不能省：log.js 在测试环境默认闭嘴，不打开就什么都抓不到，
 * 「日志里说清楚了」会退化成「没有日志」，用例绿得毫无意义。
 * 所以每条断言之前都先确认确实抓到了行。
 */
function captureStatus(env) {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  const prevFlag = process.env.LOG_IN_TEST;
  const prevEnv = {};
  for (const key of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
    prevEnv[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  console.log = (...args) => lines.push(args.map(String).join(' '));
  console.error = (...args) => lines.push(args.map(String).join(' '));
  process.env.LOG_IN_TEST = '1';
  let config;
  try {
    __resetVapidConfigForTest();
    config = logVapidStatus();
  } finally {
    console.log = origLog;
    console.error = origErr;
    if (prevFlag === undefined) delete process.env.LOG_IN_TEST;
    else process.env.LOG_IN_TEST = prevFlag;
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __resetVapidConfigForTest();
  }
  const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  assert.ok(rows.length > 0, '一行日志都没抓到 —— LOG_IN_TEST 没生效的话这个用例什么都没验');
  assert.equal(rows.length, 1, `启动自检只该打一行，实际 ${rows.length} 行：${rows.map((r) => r.event).join(', ')}`);
  return { config, row: rows[0], raw: lines[0] };
}

afterEach(() => { __resetVapidConfigForTest(); });

// ---- 不配 ----------------------------------------------------------------

describe('VAPID 自检 · 一个都不配是正常状态，不是错误', () => {
  it('三个变量都不配 → 推送关闭，不抛，reason 是 not_configured', () => {
    const config = readVapidConfig({});
    assert.equal(config.enabled, false);
    assert.equal(config.reason, R.NOT_CONFIGURED);
    assert.equal(config.publicKey, null, '关闭时不能漏出公钥，/api/push/config 直接用它');
    assert.equal(config.privateKey, null);
  });

  it('空字符串 / 只有空白 等同于没配（.env 里留着空的三行是最常见的形态）', () => {
    for (const blank of ['', '   ', '\t', '\n']) {
      const config = readVapidConfig({
        VAPID_PUBLIC_KEY: blank, VAPID_PRIVATE_KEY: blank, VAPID_SUBJECT: blank,
      });
      assert.equal(config.reason, R.NOT_CONFIGURED, `${JSON.stringify(blank)} 没被当成「没配」`);
    }
  });

  it('日志说清楚了「推送关了、别的没事、想开怎么开」，而且没被 log.js 的 200 字截断', () => {
    const { config, row } = captureStatus({});
    assert.equal(config.enabled, false);
    assert.equal(row.event, 'push.disabled', '运维靠 grep push.disabled 判断推送开没开，事件名不能改');
    assert.equal(row.level, 'warn');
    assert.equal(row.reason, R.NOT_CONFIGURED);
    assert.match(row.detail, /推送整体关闭/);
    assert.match(row.detail, /聊天|SSE|附件/, '要说清「其它功能照旧」，否则看日志的人会以为服务坏了');
    assert.match(row.hint, /generate-vapid-keys/, '要给出下一步怎么做');
    // log.js 的 MAX_VALUE_LENGTH 是 200，超了会被截成「…[共N字]」。
    // 那正好会把最关键的后半句吃掉，所以这句话必须写得下。
    for (const field of ['detail', 'hint']) {
      assert.ok(!row[field].includes('[共'), `${field} 被日志截断了：${row[field]}`);
    }
  });

  it('反向：三个都配对了就不该出现 push.disabled', () => {
    const { config, row } = captureStatus(goodEnv());
    assert.equal(config.enabled, true);
    assert.equal(row.event, 'push.enabled');
    assert.equal(row.level, 'info');
    assert.equal(row.subject, GOOD_SUBJECT);
  });

  it('开启时的日志不含私钥 —— redact 按字段名兜底，拦不住我们主动传进去的值', () => {
    const { raw } = captureStatus(goodEnv());
    assert.ok(!raw.includes(PAIR.privateKey), `私钥进日志了：${raw}`);
    assert.ok(!raw.includes(PAIR.publicKey), '公钥也只该记头几位，整串没必要进日志');
    assert.match(raw, /publicKeyHead/, '要留个能核对「线上是不是我发的那套」的短前缀');
  });
});

// ---- 只配一部分 ----------------------------------------------------------

describe('VAPID 自检 · 只配一部分要整体关闭，不许半开', () => {
  const CASES = [
    ['只有公钥', { VAPID_PUBLIC_KEY: PAIR.publicKey }, ['VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']],
    ['只有私钥', { VAPID_PRIVATE_KEY: PAIR.privateKey }, ['VAPID_PUBLIC_KEY', 'VAPID_SUBJECT']],
    ['只有 subject', { VAPID_SUBJECT: GOOD_SUBJECT }, ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']],
    ['有一对密钥但忘了 subject', { VAPID_PUBLIC_KEY: PAIR.publicKey, VAPID_PRIVATE_KEY: PAIR.privateKey }, ['VAPID_SUBJECT']],
    ['有 subject 和公钥，缺私钥', { VAPID_PUBLIC_KEY: PAIR.publicKey, VAPID_SUBJECT: GOOD_SUBJECT }, ['VAPID_PRIVATE_KEY']],
  ];

  for (const [name, env, missing] of CASES) {
    it(`${name} → partial_config，并点名缺哪几项`, () => {
      const config = readVapidConfig(env);
      assert.equal(config.enabled, false, '半开状态最糟：订阅存下来了却永远推不出去');
      assert.equal(config.reason, R.PARTIAL_CONFIG);
      for (const key of missing) {
        assert.ok(config.detail.includes(key), `detail 没说缺 ${key}：${config.detail}`);
      }
      assert.equal(config.publicKey, null);
    });
  }

  it('「缺一项」和「一个都没配」是两个不同的 reason，不能混成一个', () => {
    // 混在一起的话，运维看到 not_configured 会以为「本来就没打算开」，
    // 而实际情况是「打算开、配了两行、漏了一行」—— 这两种要的下一步动作完全不同。
    assert.notEqual(
      readVapidConfig({ VAPID_SUBJECT: GOOD_SUBJECT }).reason,
      readVapidConfig({}).reason,
    );
  });

  it('半配也打一行 push.disabled，级别是 warn', () => {
    const { row } = captureStatus({ VAPID_SUBJECT: GOOD_SUBJECT });
    assert.equal(row.event, 'push.disabled');
    assert.equal(row.reason, R.PARTIAL_CONFIG);
    assert.match(row.detail, /VAPID_PUBLIC_KEY/);
  });
});

// ---- VAPID_SUBJECT ---------------------------------------------------------

describe('VAPID 自检 · VAPID_SUBJECT 的合法形式', () => {
  const OK = [
    'mailto:admin@im.example.com',
    'mailto:admin@example.com',                  // .env.example 里的占位值，必须能过
    'mailto:ops-team@sub.domain.example.org',
    'mailto:a.b+push@example.co.uk',
    'MAILTO:Admin@Example.COM',                  // 大小写不敏感
    'https://im.example.com',
    'https://im.example.com/contact',
    'https://example.com/push?owner=ops',
    '  mailto:admin@example.com  ',              // .env 里粘贴常带的前后空格
  ];

  for (const subject of OK) {
    it(`通过：${subject}`, () => {
      assert.equal(validateSubject(subject).ok, true, `被误拒了：${JSON.stringify(validateSubject(subject))}`);
      assert.equal(readVapidConfig(goodEnv({ VAPID_SUBJECT: subject })).enabled, true);
    });
  }

  it('通过之后 subject 原样传给下游（2A 签 JWT 要用），只去掉首尾空白', () => {
    const config = readVapidConfig(goodEnv({ VAPID_SUBJECT: '  mailto:admin@example.com  ' }));
    assert.equal(config.subject, 'mailto:admin@example.com');
  });
});

describe('VAPID 自检 · VAPID_SUBJECT 不可路由 —— 这是 iPhone 收不到推送的头号原因', () => {
  const NOT_ROUTABLE = [
    ['经典坑：mailto 到 localhost', 'mailto:admin@localhost'],
    ['本机 IP', 'mailto:admin@127.0.0.1'],
    ['内网 IP', 'https://192.168.1.10/contact'],
    ['mDNS 域名', 'mailto:admin@nas.local'],
    ['ICANN 划的内网专用域', 'https://im.internal/contact'],
    ['路由器默认域', 'mailto:admin@server.lan'],
    ['公司内网域', 'https://im.corp/contact'],
    ['RFC 2606 保留域', 'mailto:admin@foo.test'],
    ['单标签主机名（内网 DNS 能解，公网上不存在）', 'https://intranet/contact'],
    ['https 到 localhost', 'https://localhost:4000'],
    ['IPv6', 'https://[::1]/contact'],
  ];

  for (const [name, subject] of NOT_ROUTABLE) {
    it(`拒绝（${name}）：${subject}`, () => {
      const verdict = validateSubject(subject);
      assert.equal(verdict.ok, false, `${subject} 被放过去了 —— 上生产 iPhone 会一条都收不到`);
      assert.equal(verdict.reason, R.SUBJECT_NOT_ROUTABLE);
      // 报错必须是人话，而且必须点出苹果那个 403 —— 只说「不合法」的话，
      // 看日志的人第一反应是「我们内网访问得到啊」，然后就把这行忽略了。
      assert.match(verdict.detail, /403 BadJwtToken/, `没提苹果的 403：${verdict.detail}`);
      assert.match(verdict.detail, /不可路由/);
      assert.ok(verdict.hint.length > 0 && /例如/.test(verdict.hint), `没给出正确写法：${verdict.hint}`);

      const config = readVapidConfig(goodEnv({ VAPID_SUBJECT: subject }));
      assert.equal(config.enabled, false);
      assert.equal(config.reason, R.SUBJECT_NOT_ROUTABLE);
    });
  }

  it('日志里那句 403 BadJwtToken 不会被 log.js 的 200 字上限截掉', () => {
    const { row } = captureStatus(goodEnv({ VAPID_SUBJECT: 'mailto:admin@localhost' }));
    assert.equal(row.reason, R.SUBJECT_NOT_ROUTABLE);
    assert.match(row.detail, /403 BadJwtToken/, `被截断了：${row.detail}`);
    assert.ok(!row.detail.includes('[共'), `detail 被截断：${row.detail}`);
  });

  it('反向对照：同样的写法换成真实域名就该通过（证明上面拒的是「不可路由」，不是「凡是 mailto 都拒」）', () => {
    assert.equal(validateSubject('mailto:admin@nas.example.com').ok, true);
    assert.equal(validateSubject('https://im.example.com/contact').ok, true);
  });
});

describe('VAPID 自检 · VAPID_SUBJECT 格式本身就不对', () => {
  const INVALID = [
    ['空的', ''],
    ['只有空白', '   '],
    ['纯字符串，没有任何前缀', 'admin@example.com'],
    ['随手写的一句话', '运维找老王'],
    ['http:// —— RFC 8292 只认 mailto: 和 https:', 'http://im.example.com'],
    ['写成了 ws://', 'ws://im.example.com'],
    ['mailto: 后面是空的', 'mailto:'],
    ['mailto: 没有 @', 'mailto:admin'],
    ['mailto: @ 后面是空的', 'mailto:admin@'],
    ['一次写了两个邮箱', 'mailto:a@example.com,b@example.com'],
    ['mailto: 带了参数', 'mailto:a@example.com?subject=hi'],
    ['中间有空格', 'mailto:admin @example.com'],
    ['整个值是一段 JSON（配置写串了）', '{"subject":"mailto:a@example.com"}'],
  ];

  for (const [name, subject] of INVALID) {
    it(`拒绝（${name}）：${JSON.stringify(subject)}`, () => {
      const verdict = validateSubject(subject);
      assert.equal(verdict.ok, false, `${JSON.stringify(subject)} 被放过去了`);
      assert.equal(verdict.reason, R.INVALID_SUBJECT);
      assert.ok(/[一-龥]/.test(verdict.detail), `报错不是人话：${verdict.detail}`);
      assert.ok(/[一-龥]/.test(verdict.hint), `没给出人话的修法：${verdict.hint}`);
    });
  }

  it('http:// 的报错要专门说「改成 https」，不能只说「不合法」', () => {
    const verdict = validateSubject('http://im.example.com');
    assert.match(verdict.detail, /http:\/\//);
    assert.match(verdict.hint, /https/);
  });

  it('非法 subject 也只是关掉推送，不抛异常', () => {
    for (const [, subject] of INVALID) {
      assert.doesNotThrow(() => readVapidConfig(goodEnv({ VAPID_SUBJECT: subject })));
    }
  });
});

// ---- 密钥 -----------------------------------------------------------------

describe('VAPID 自检 · 公钥 / 私钥', () => {
  it('合法的一对 → enabled，三项原样传下去', () => {
    const config = readVapidConfig(goodEnv());
    assert.equal(config.enabled, true);
    assert.equal(config.publicKey, PAIR.publicKey);
    assert.equal(config.privateKey, PAIR.privateKey);
    assert.equal(config.subject, GOOD_SUBJECT);
    assert.equal(config.reason, undefined, '开着的时候不该有 reason');
  });

  it('标准 base64（含 + / =）要专门提示，这是最常见的手滑', () => {
    const b64 = Buffer.from(PAIR.publicKey, 'base64url').toString('base64'); // 带 + / =
    const config = readVapidConfig(goodEnv({ VAPID_PUBLIC_KEY: b64 }));
    assert.equal(config.reason, R.INVALID_KEY);
    assert.match(config.detail, /base64url/);
  });

  it('公钥私钥填反了要直说，别只报「格式不对」', () => {
    const config = readVapidConfig(goodEnv({
      VAPID_PUBLIC_KEY: PAIR.privateKey,
      VAPID_PRIVATE_KEY: PAIR.publicKey,
    }));
    assert.equal(config.reason, R.INVALID_KEY);
    assert.match(config.detail, /填反/);
  });

  it('两把钥匙各自都合法、但不是一对 —— 必须拦住', () => {
    // Node 从 JWK 导入 EC 私钥时不检查 d 和 (x,y) 匹配，光靠「能导入」是拦不住的。
    // 真实来源很常见：生成脚本跑了两次，公钥抄第一次的、私钥抄第二次的。
    const other = freshPair();
    const config = readVapidConfig(goodEnv({ VAPID_PRIVATE_KEY: other.privateKey }));
    assert.equal(config.enabled, false, '不成对的密钥被放过去了，推过去会被对方以签名错拒掉');
    assert.equal(config.reason, R.INVALID_KEY);
    assert.match(config.detail, /不是一对/);
  });

  it('各种坏掉的密钥值都只是关闭推送，不抛', () => {
    const BAD = [
      'not-base64url!!',
      'AAAA',                                                  // 太短
      PAIR.publicKey.slice(0, -4),                             // 粘漏了一截
      `${PAIR.publicKey}AAAA`,                                 // 多粘了一截
      Buffer.alloc(65, 7).toString('base64url'),               // 长度对，但点不在曲线上
      Buffer.concat([Buffer.from([0x02]), Buffer.alloc(64)]).toString('base64url'), // 压缩点前缀
      'BEGIN PUBLIC KEY',
    ];
    for (const value of BAD) {
      let config;
      assert.doesNotThrow(() => { config = readVapidConfig(goodEnv({ VAPID_PUBLIC_KEY: value })); }, `抛了：${value}`);
      assert.equal(config.enabled, false, `坏公钥被放过去了：${value}`);
      assert.equal(config.reason, R.INVALID_KEY, `reason 不对：${value}`);
      assert.ok(/[一-龥]/.test(config.detail), `报错不是人话：${config.detail}`);
    }
  });

  it('密钥和 subject 同时错时，两条毛病一次全说完（省一轮「改一个重启一次」）', () => {
    const config = readVapidConfig({
      VAPID_PUBLIC_KEY: 'garbage!!',
      VAPID_PRIVATE_KEY: PAIR.privateKey,
      VAPID_SUBJECT: 'mailto:admin@localhost',
    });
    assert.equal(config.enabled, false);
    assert.match(config.detail, /VAPID_PUBLIC_KEY/);
    assert.match(config.detail, /VAPID_SUBJECT/);
  });
});

// ---- 生成脚本与校验的口径一致 ---------------------------------------------

describe('VAPID 自检 · 生成脚本产出的密钥必须能通过校验', () => {
  /** 真的把脚本跑起来，只取 stdout（脚本约定：stdout 只有那三行，提示走 stderr）。 */
  const runScript = (args = []) => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  const parseEnv = (stdout) => Object.fromEntries(
    stdout.trim().split('\n').map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }),
  );

  it('脚本的输出直接喂给 readVapidConfig 就是 enabled —— 生成和校验是同一套口径', () => {
    const env = parseEnv(runScript(['--subject', 'mailto:ops@im.example.com']));
    const config = readVapidConfig(env);
    assert.equal(config.enabled, true, `生成的密钥被自己的校验拒了：${config.reason} / ${config.detail}`);
    assert.equal(config.subject, 'mailto:ops@im.example.com');
  });

  it('默认（不给 --subject）的输出也能通过 —— .env.example 里的占位值不能是个过不了自检的值', () => {
    const env = parseEnv(runScript());
    assert.equal(readVapidConfig(env).enabled, true);
    assert.equal(env.VAPID_SUBJECT, 'mailto:admin@example.com');
  });

  it('stdout 恰好三行，且就是那三个变量名（保证 `>> .env` 这个用法是安全的）', () => {
    const lines = runScript().trim().split('\n');
    assert.equal(lines.length, 3, `stdout 混进了别的东西：${JSON.stringify(lines)}`);
    assert.deepEqual(
      lines.map((l) => l.slice(0, l.indexOf('='))),
      ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
    );
  });

  it('每次跑出来的是不同的一对（不是写死的示例密钥）', () => {
    const a = parseEnv(runScript());
    const b = parseEnv(runScript());
    assert.notEqual(a.VAPID_PUBLIC_KEY, b.VAPID_PUBLIC_KEY);
    assert.notEqual(a.VAPID_PRIVATE_KEY, b.VAPID_PRIVATE_KEY);
  });

  it('反向：脚本用的是和服务端同一个 subject 校验 —— localhost 会被脚本自己挡下来', () => {
    // 不共用校验的话，脚本会开开心心生成一份「服务端启动时就会关掉推送」的配置。
    assert.throws(
      () => runScript(['--subject', 'mailto:admin@localhost']),
      (err) => {
        assert.equal(err.status, 1, '脚本应该非零退出');
        assert.match(String(err.stderr), /subject_not_routable/);
        assert.equal(String(err.stdout).trim(), '', '被拒时不该输出任何配置行');
        return true;
      },
    );
  });
});

// ---- deploy/.env.example --------------------------------------------------

describe('VAPID 自检 · 照抄 deploy/.env.example 得到的默认状态', () => {
  /** 按 --env-file 的规矩解析：`#` 开头的整行是注释，不产生变量。 */
  const exampleEnv = () => Object.fromEntries(
    readFileSync(join(HERE, '..', '..', 'deploy', '.env.example'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
      .map((line) => {
        const i = line.indexOf('=');
        return i < 0 ? null : [line.slice(0, i).trim(), line.slice(i + 1)];
      })
      .filter(Boolean),
  );

  it('默认是 not_configured —— 不能是 partial_config 或 invalid_key', () => {
    // 这条防的是一个很具体的坑：.env.example 里留一个空的 VAPID_PUBLIC_KEY=、
    // 又把 VAPID_SUBJECT=mailto:admin@example.com 填上，看起来很贴心，
    // 实际上「三项里有一项非空」= partial_config，于是每个**根本没打算开推送**的
    // 部署，启动日志里都会多一条「只配了一部分」的 warn，白白吓人一跳。
    const config = readVapidConfig(exampleEnv());
    assert.equal(config.enabled, false);
    assert.equal(config.reason, R.NOT_CONFIGURED, `默认状态是 ${config.reason}，会让没开推送的部署看到一条莫名其妙的告警`);
  });

  it('里面没有任何看起来像真密钥的东西', () => {
    const raw = readFileSync(join(HERE, '..', '..', 'deploy', '.env.example'), 'utf8');
    // 87 个 base64url 字符 = 一个真的 P-256 公钥点。示例文件里出现这个就是把密钥提交进仓库了。
    assert.equal(/[A-Za-z0-9_-]{80,}/.test(raw), false, '.env.example 里像是塞了真实密钥');
  });

  it('三个变量名都在文件里出现过（哪怕是注释掉的）—— 否则运维根本不知道有这三项', () => {
    const raw = readFileSync(join(HERE, '..', '..', 'deploy', '.env.example'), 'utf8');
    for (const key of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
      assert.ok(raw.includes(key), `.env.example 里没提到 ${key}`);
    }
  });
});

// ---- 单例与对外接口 --------------------------------------------------------

describe('VAPID 自检 · 单例与对外接口', () => {
  it('vapidConfig() 只算一次并缓存（每条推送重算一遍签名验签是白烧 CPU）', () => {
    const prev = { ...process.env };
    process.env.VAPID_PUBLIC_KEY = PAIR.publicKey;
    process.env.VAPID_PRIVATE_KEY = PAIR.privateKey;
    process.env.VAPID_SUBJECT = GOOD_SUBJECT;
    try {
      __resetVapidConfigForTest();
      const first = vapidConfig();
      assert.equal(first.enabled, true);
      assert.equal(pushEnabled(), true);
      delete process.env.VAPID_SUBJECT;                 // 改了 env 也不该影响已缓存的结果
      assert.equal(vapidConfig(), first, '没缓存');
      __resetVapidConfigForTest();
      assert.equal(vapidConfig().enabled, false, '重置之后应该重新读一遍 env');
    } finally {
      for (const key of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
      __resetVapidConfigForTest();
    }
  });

  it('默认（测试环境没配 VAPID）时 pushEnabled() 是 false，且不抛', () => {
    __resetVapidConfigForTest();
    assert.doesNotThrow(() => pushEnabled());
    assert.equal(pushEnabled(), false);
  });

  it('reason 常量表是冻住的，别在别处写字符串字面量', () => {
    assert.equal(Object.isFrozen(R), true);
    assert.deepEqual(Object.values(R).sort(), [
      'invalid_key', 'invalid_subject', 'not_configured', 'partial_config', 'subject_not_routable',
    ]);
  });
});
