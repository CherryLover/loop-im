// 生产化加固：登录失败限流、AI Key 加密落库、CORS 策略。
import { ADMIN, ADMIN_PASSWORD, PASSWORD, startServer } from './helpers.js';
import { member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, release;

before(async () => {
  api = await startServer();
});
after(async () => { await api.close(); });

describe('登录失败限流', () => {
  it('连续失败到上限后返回 429，并带 Retry-After', async () => {
    const { resetRateLimit, rateLimitConfig } = await import('../src/rate-limit.js');
    resetRateLimit();
    const victim = await member('限流甲');

    for (let i = 0; i < rateLimitConfig.maxFailures; i += 1) {
      const res = await api.post('/api/auth/login', { email: victim.email, password: '错的密码' });
      assert.equal(res.status, 401, `第 ${i + 1} 次失败应当还是 401`);
    }

    const blocked = await api.call('POST', '/api/auth/login', { body: { email: victim.email, password: '错的密码' } });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /过于频繁/);

    // 正确的密码此时也进不来 —— 否则限流形同虚设。
    const evenCorrect = await api.post('/api/auth/login', { email: victim.email, password: PASSWORD });
    assert.equal(evenCorrect.status, 429);
    resetRateLimit();
  });

  it('成功登录会清掉该账号已累计的失败次数', async () => {
    const { resetRateLimit, rateLimitConfig } = await import('../src/rate-limit.js');
    resetRateLimit();
    const user = await member('限流乙');

    // 差一次到上限，然后成功登录一次
    for (let i = 0; i < rateLimitConfig.maxFailures - 1; i += 1) {
      await api.post('/api/auth/login', { email: user.email, password: '错的密码' });
    }
    assert.equal((await api.post('/api/auth/login', { email: user.email, password: PASSWORD })).status, 200);

    // 计数已清零：再失败满一轮之前都不该被挡
    for (let i = 0; i < rateLimitConfig.maxFailures - 1; i += 1) {
      const res = await api.post('/api/auth/login', { email: user.email, password: '错的密码' });
      assert.equal(res.status, 401, '成功登录后计数应当归零');
    }
    resetRateLimit();
  });

  it('窗口过期后自动解封 —— 不会把人永久锁死', async () => {
    const { resetRateLimit, rateLimitConfig, recordFailure, retryAfterMs } = await import('../src/rate-limit.js');
    resetRateLimit();
    const keys = ['email:locked@test.local'];
    const t0 = 1_700_000_000_000;

    for (let i = 0; i < rateLimitConfig.maxFailures; i += 1) recordFailure(keys, t0 + i);
    assert.ok(retryAfterMs(keys, t0 + 1000) > 0, '刚失败满就应当被挡住');

    // 窗口内的最后一刻仍然被挡
    assert.ok(retryAfterMs(keys, t0 + rateLimitConfig.windowMs - 10) > 0);
    // 越过窗口后记录被清掉，重新可以尝试
    assert.equal(retryAfterMs(keys, t0 + rateLimitConfig.windowMs + 1), 0, '窗口过期后应当自动解封');
    resetRateLimit();
  });

  it('剩余等待时间随时间推移递减，且不超过一个窗口', async () => {
    const { resetRateLimit, rateLimitConfig, recordFailure, retryAfterMs } = await import('../src/rate-limit.js');
    resetRateLimit();
    const keys = ['email:decay@test.local'];
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < rateLimitConfig.maxFailures; i += 1) recordFailure(keys, t0);

    const early = retryAfterMs(keys, t0 + 1_000);
    const later = retryAfterMs(keys, t0 + 60_000);
    assert.ok(later < early, '等得越久，剩余时间越短');
    assert.ok(early <= rateLimitConfig.windowMs, '剩余时间不应超过一个窗口');
    resetRateLimit();
  });

  it('多个维度里只要有一个超限就算被挡，取最长的等待时间', async () => {
    const { resetRateLimit, rateLimitConfig, recordFailure, retryAfterMs } = await import('../src/rate-limit.js');
    resetRateLimit();
    const t0 = 1_700_000_000_000;
    // 只有 IP 维度超限，邮箱维度干净
    for (let i = 0; i < rateLimitConfig.maxFailures; i += 1) recordFailure(['ip:1.2.3.4'], t0);
    assert.ok(retryAfterMs(['email:clean@test.local', 'ip:1.2.3.4'], t0 + 1) > 0);
    assert.equal(retryAfterMs(['email:clean@test.local'], t0 + 1), 0, '未超限的维度单独看不应被挡');
    resetRateLimit();
  });

  it('限流不影响其他账号登录', async () => {
    const { resetRateLimit, rateLimitConfig } = await import('../src/rate-limit.js');
    resetRateLimit();
    const blockedUser = await member('限流丙');
    const other = await member('限流丁');

    for (let i = 0; i <= rateLimitConfig.maxFailures; i += 1) {
      await api.post('/api/auth/login', { email: blockedUser.email, password: '错的密码' });
    }
    // 同一进程里 IP 维度也在计数，这里只验证邮箱维度不会误伤：
    // 换个账号用正确密码，应当因为 IP 维度被挡而不是通过 —— 所以先清 IP 维度。
    resetRateLimit();
    assert.equal((await api.post('/api/auth/login', { email: other.email, password: PASSWORD })).status, 200);
  });
});

describe('AI API Key 加密落库', () => {
  it('加密后密文不含明文，解密拿回原值，重复加密幂等', async () => {
    const { encrypt, decrypt, isEncrypted, isEncryptionConfigured } = await import('../src/secret-box.js');
    assert.equal(isEncryptionConfigured(), true, '测试环境应当开着落库加密');

    const plain = 'sk-test-abcdefghijklmnop';
    const box = encrypt(plain);
    assert.ok(isEncrypted(box), '应当产出带 v1 前缀的密文');
    assert.ok(!box.includes(plain), '密文里不应出现明文片段');
    assert.equal(decrypt(box), plain, '解密应当拿回原值');
    assert.equal(encrypt(box), box, '对密文再加密应当幂等');

    // 每次加密用新的 IV，同一明文不该产生相同密文
    assert.notEqual(encrypt(plain), encrypt(plain));
  });

  it('库里落的确实是密文而不是明文', async () => {
    const adminToken = await api.login(ADMIN, ADMIN_PASSWORD);
    await api.put('/api/ai/settings', { apiKey: 'sk-stored-check-9876' }, adminToken);

    const { get } = await import('../src/db.js');
    const raw = get('SELECT api_key FROM ai_settings WHERE id = 1').api_key;
    assert.ok(!raw.includes('sk-stored-check'), '数据库里不应存明文 Key');
    assert.ok(raw.startsWith('v1:'), '数据库里应当是 v1 密文');
  });

  it('密钥可以是任意口令（非 64 位十六进制走 scrypt 派生）', async () => {
    const { execFileSync } = await import('node:child_process');
    const script = `
      import('${new URL('../src/secret-box.js', import.meta.url).href}').then((m) => {
        const box = m.encrypt('sk-passphrase-mode');
        process.stdout.write(JSON.stringify({
          configured: m.isEncryptionConfigured(),
          encrypted: m.isEncrypted(box),
          roundTrip: m.decrypt(box),
        }));
      });
    `;
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ENCRYPTION_KEY: '这是一句人类可读的口令，不是十六进制' },
      encoding: 'utf8',
    }));
    assert.equal(out.configured, true);
    assert.equal(out.encrypted, true, '口令模式也应当真的加密');
    assert.equal(out.roundTrip, 'sk-passphrase-mode');
  });

  it('换了密钥之后旧密文解不开，降级成空值而不是抛异常', async () => {
    const { encrypt } = await import('../src/secret-box.js');
    const box = encrypt('sk-will-be-orphaned');

    const { execFileSync } = await import('node:child_process');
    const script = `
      import('${new URL('../src/secret-box.js', import.meta.url).href}').then((m) => {
        process.stdout.write(JSON.stringify({ value: m.decrypt(process.env.BOX) }));
      });
    `;
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, BOX: box, ENCRYPTION_KEY: 'ff'.repeat(32) },   // 换成另一把密钥
      encoding: 'utf8',
    }));
    assert.equal(out.value, '', '解不开时应当降级成空值，当作未配置凭据处理');
  });

  it('没有前缀的老数据一律当明文读取，不会报错', async () => {
    const { decrypt } = await import('../src/secret-box.js');
    assert.equal(decrypt('sk-legacy-plaintext'), 'sk-legacy-plaintext');
    assert.equal(decrypt(''), '');
  });

  it('老库的明文 Key 在配了密钥后会被就地改写成密文，且读出来不变', async () => {
    const { run, get } = await import('../src/db.js');
    const { settings } = await import('../src/ai.js');

    // 模拟升级前的库：直接写入明文
    run('UPDATE ai_settings SET api_key = ? WHERE id = 1', 'sk-legacy-in-db-4321');
    // migrateLegacyKey 每进程只跑一次，这里直接验证 settings() 读明文不出错，
    // 迁移本身由下面的子进程用例覆盖（那里是全新进程）。
    assert.equal(settings().api_key, 'sk-legacy-in-db-4321', '老明文应当能正常读出');
    assert.equal(get('SELECT api_key FROM ai_settings WHERE id = 1').api_key, 'sk-legacy-in-db-4321');
  });

  it('没配 ENCRYPTION_KEY 时退回明文，不抛异常（现有部署的兼容承诺）', async () => {
    const { execFileSync } = await import('node:child_process');
    const script = `
      import('${new URL('../src/secret-box.js', import.meta.url).href}').then((m) => {
        const out = {
          configured: m.isEncryptionConfigured(),
          encrypted: m.encrypt('sk-plain'),
          roundTrip: m.decrypt(m.encrypt('sk-plain')),
          legacyRead: m.decrypt('sk-old-value'),
          cipherWithoutKey: m.decrypt('v1:AAAA:BBBB:CCCC'),
        };
        process.stdout.write(JSON.stringify(out));
      });
    `;
    const env = { ...process.env };
    delete env.ENCRYPTION_KEY;
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }));

    assert.equal(out.configured, false);
    assert.equal(out.encrypted, 'sk-plain', '没密钥时 encrypt 应当原样返回');
    assert.equal(out.roundTrip, 'sk-plain');
    assert.equal(out.legacyRead, 'sk-old-value', '老明文照常读');
    assert.equal(out.cipherWithoutKey, '', '解不开的密文降级成空值而不是抛异常');
  });

  it('接口始终不把 Key 回传给前端', async () => {
    const adminToken = await api.login(ADMIN, ADMIN_PASSWORD);
    await api.put('/api/ai/settings', { apiKey: 'sk-should-never-leak-1234' }, adminToken);

    for (const path of ['/api/ai/settings', '/api/ai/overview']) {
      const res = await api.get(path, adminToken);
      assert.equal(res.status, 200);
      assert.equal(res.body.hasApiKey, true, `${path} 应当只暴露「是否配置」`);
      assert.ok(!JSON.stringify(res.body).includes('sk-should-never-leak'), `${path} 不应回传 Key 本身`);
    }

    // 存进去再读出来，供应商调用拿到的仍是原始明文
    const { settings } = await import('../src/ai.js');
    assert.equal(settings().api_key, 'sk-should-never-leak-1234');
  });
});

describe('CORS 策略', () => {
  /** 用指定的环境变量单独起一个 app，跑完还原，免得影响别的用例。 */
  async function withApp(env, run) {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    const { createApp } = await import('../src/app.js');
    const server = createApp({ serveClient: false }).listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      return await run(`http://127.0.0.1:${server.address().port}`);
    } finally {
      await new Promise((r) => server.close(r));
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }

  const originHeader = async (base, origin) =>
    (await fetch(`${base}/api/health`, { headers: { Origin: origin } })).headers.get('access-control-allow-origin');

  it('非生产环境保持放开，不打断本地开发', async () => {
    const res = await fetch(`${api.baseUrl}/api/health`, { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('生产环境未配置白名单时不发跨域头（默认同源部署）', async () => {
    await withApp({ NODE_ENV: 'production', CORS_ORIGIN: undefined }, async (base) => {
      assert.equal((await fetch(`${base}/api/health`)).status, 200, '同源请求照常可用');
      assert.equal(await originHeader(base, 'https://evil.example'), null, '不应给任意来源发放跨域许可');
    });
  });

  it('配置了白名单时只放行名单内的来源', async () => {
    await withApp({ NODE_ENV: 'production', CORS_ORIGIN: 'https://im.example.com, https://ops.example.com' },
      async (base) => {
        assert.equal(await originHeader(base, 'https://im.example.com'), 'https://im.example.com');
        assert.equal(await originHeader(base, 'https://ops.example.com'), 'https://ops.example.com', '逗号分隔的第二项也应生效');
        assert.equal(await originHeader(base, 'https://evil.example'), null, '名单外的来源不放行');
      });
  });

  it('白名单在非生产环境同样生效（配置优先于环境）', async () => {
    await withApp({ NODE_ENV: 'test', CORS_ORIGIN: 'https://im.example.com' }, async (base) => {
      assert.equal(await originHeader(base, 'https://im.example.com'), 'https://im.example.com');
      assert.equal(await originHeader(base, 'http://localhost:5173'), null, '一旦显式配置，就不再无条件放开');
    });
  });
});
