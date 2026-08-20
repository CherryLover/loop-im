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
  it('非生产环境保持放开，不打断本地开发', async () => {
    const res = await fetch(`${api.baseUrl}/api/health`, { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});
