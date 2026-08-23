// Web Push 订阅的存储、接口与账号联动。
//
// 这个文件里安全用例占一半，都不是「体验问题」：
// - 同一台设备换个人登录 → 旧的那个人必须立刻查不到（否则他继续收别人的消息摘要）；
// - 删订阅只能删自己的（否则谁都能把别人的推送关掉）；
// - 「不是你的」和「压根不存在」必须是同一种响应（否则接口成了 endpoint 探针）；
// - 账号停用 → 订阅一起清（disconnect 只掐 SSE，推送是另一条独立通道）。
//
// ⚠️ 路由挂载：`/api/push` 目前**没有**挂进 `src/app.js` —— 那个文件在 PR2 里归 2C，
// 这个任务包无权改。所以下面用 `startPushApi()` 单独把 `routes/push.js` 挂在一个
// 极小的 express 上跑：中间件、鉴权、路由本身全是真的，只有挂载点是测试自己搭的。
// 等 app.js 里加上 `app.use('/api/push', pushRoutes)` 之后，这个 helper 可以换成
// 共享的 startServer()，用例一条都不用改。
import './helpers.js';
import { ADMIN, ADMIN_PASSWORD, PASSWORD, startServer } from './helpers.js';
import { member } from './fixtures.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';

let api;              // 完整 API（登录、停用账号）
let push;             // 只挂了 /api/push 的小服务
let store;            // src/push-store.js
let db;               // src/db.js，用来直接查库断言

let chen;             // 陈子航
let zhou;             // 周雨桐
let chenToken;
let zhouToken;
let adminToken;

/**
 * 造一副**真的** P-256 公钥 + 16 字节 auth。
 * 不用手写字符串常量：校验会验非压缩点的首字节 0x04 和 65 字节长度，
 * 随手编的 87 个字符过不了，而过得了的常量看不出来它为什么是对的。
 */
function realKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}

let endpointSeq = 0;
const nextEndpoint = () => `https://web.push.apple.com/loop-${(endpointSeq += 1)}`;

/** 一条完整的、合法的上报体。 */
const payload = (deviceId = 'dev-iphone', endpoint = nextEndpoint()) => ({
  deviceId,
  subscription: { endpoint, keys: realKeys() },
});

/** 只挂 /api/push 的小服务（见文件头那段说明）。 */
async function startPushApi() {
  const express = (await import('express')).default;
  const { router } = await import('../src/routes/push.js');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/push', router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { token, body, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}${path}`, {
      method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
  };

  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** 库里某个人名下的订阅行（原始列名，方便断言 ua / fail_count 这些不在对外形状里的字段）。 */
const rowsOf = (userId) =>
  db.all('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at, rowid', userId);
const rowAt = (endpoint) => db.get('SELECT * FROM push_subscriptions WHERE endpoint = ?', endpoint);
const totalRows = () => db.get('SELECT count(*) AS n FROM push_subscriptions').n;

before(async () => {
  api = await startServer();
  push = await startPushApi();
  store = await import('../src/push-store.js');
  db = await import('../src/db.js');
  [chen, zhou] = [await member('陈子航'), await member('周雨桐')];
  chenToken = await api.login(chen.email, PASSWORD);
  zhouToken = await api.login(zhou.email, PASSWORD);
  adminToken = await api.login(ADMIN, ADMIN_PASSWORD);
});

after(async () => {
  await push.close();
  await api.close();
});

beforeEach(() => {
  db.run('DELETE FROM push_subscriptions');
});

describe('订阅上报的格式校验', () => {
  it('合法的一条能过，返回的 value 可以直接入库', () => {
    const body = payload();
    const check = store.validateSubscriptionInput(body);
    assert.equal(check.ok, true);
    assert.equal(check.value.endpoint, body.subscription.endpoint);
    assert.equal(check.value.deviceId, 'dev-iphone');
  });

  it('endpoint 不是 https 一律拒（http / 内网地址都是 SSRF 入口）', () => {
    for (const endpoint of ['http://web.push.apple.com/x', 'http://127.0.0.1:8080/x', 'file:///etc/passwd']) {
      const check = store.validateSubscriptionInput({ deviceId: 'd', subscription: { endpoint, keys: realKeys() } });
      assert.equal(check.ok, false, `${endpoint} 不该通过`);
    }
  });

  it('endpoint 压根不是 URL、为空、或者超长，都拒', () => {
    const keys = realKeys();
    for (const endpoint of ['', '   ', '不是网址', `https://x.test/${'a'.repeat(4000)}`, null, 42]) {
      const check = store.validateSubscriptionInput({ deviceId: 'd', subscription: { endpoint, keys } });
      assert.equal(check.ok, false, `${endpoint} 不该通过`);
    }
  });

  it('p256dh 长度不对就拒：短一字节、长一字节、空串都不行', () => {
    const raw = createECDH('prime256v1');
    raw.generateKeys();
    const full = raw.getPublicKey();
    const cases = [
      full.subarray(0, 64).toString('base64url'),                       // 64 字节
      Buffer.concat([full, Buffer.from([0])]).toString('base64url'),    // 66 字节
      '',
    ];
    for (const p256dh of cases) {
      const check = store.validateSubscriptionInput({
        deviceId: 'd', subscription: { endpoint: nextEndpoint(), keys: { p256dh, auth: realKeys().auth } },
      });
      assert.equal(check.ok, false, `长度 ${p256dh.length} 的 p256dh 不该通过`);
    }
  });

  it('p256dh 首字节不是 0x04（不是非压缩点）也拒——留着它每次群发都会失败一次', () => {
    const raw = createECDH('prime256v1');
    raw.generateKeys();
    const bad = Buffer.from(raw.getPublicKey());
    bad[0] = 0x03;                                    // 长度还是 65，只有 tag 不对
    const check = store.validateSubscriptionInput({
      deviceId: 'd',
      subscription: { endpoint: nextEndpoint(), keys: { p256dh: bad.toString('base64url'), auth: realKeys().auth } },
    });
    assert.equal(check.ok, false);
  });

  it('不是 base64url 字符集的一律拒，哪怕它「凑巧能解出 65 字节」', () => {
    const { auth } = realKeys();
    // Buffer.from(s, 'base64url') 会把不认识的字符**默默跳过**，所以只看解码长度是拦不住的：
    // 下面这串前面塞了 4 个 '!'，解出来照样是 65 字节。字符集必须自己验。
    const good = realKeys().p256dh;
    const sneaky = `!!!!${good}`;
    assert.equal(Buffer.from(sneaky, 'base64url').length, 65, '前提：Node 确实会跳过非法字符');
    const check = store.validateSubscriptionInput({
      deviceId: 'd', subscription: { endpoint: nextEndpoint(), keys: { p256dh: sneaky, auth } },
    });
    assert.equal(check.ok, false, '字符集不合法就该拒，不能靠解码长度兜底');
  });

  it('标准 base64 的 + / 不算 base64url', () => {
    const { auth } = realKeys();
    const check = store.validateSubscriptionInput({
      deviceId: 'd',
      subscription: { endpoint: nextEndpoint(), keys: { p256dh: `+/${realKeys().p256dh.slice(2)}`, auth } },
    });
    assert.equal(check.ok, false);
  });

  it('auth 必须解出 16 字节，多一字节少一字节都拒', () => {
    const { p256dh } = realKeys();
    for (const auth of [randomBytes(15).toString('base64url'), randomBytes(17).toString('base64url'), '', 'x']) {
      const check = store.validateSubscriptionInput({
        deviceId: 'd', subscription: { endpoint: nextEndpoint(), keys: { p256dh, auth } },
      });
      assert.equal(check.ok, false, `${auth.length} 字符的 auth 不该通过`);
    }
  });

  it('deviceId 缺失 / 空白 / 带控制字符都拒（2C 要拿它当在线判定的键）', () => {
    const keys = realKeys();
    for (const deviceId of [undefined, '', '   ', 'a\nb', 'x'.repeat(200), 123]) {
      const check = store.validateSubscriptionInput({ deviceId, subscription: { endpoint: nextEndpoint(), keys } });
      assert.equal(check.ok, false, `deviceId=${JSON.stringify(deviceId)} 不该通过`);
    }
  });

  it('keys 整个缺失、subscription 整个缺失，不会抛异常，只是不通过', () => {
    for (const input of [undefined, {}, { deviceId: 'd' }, { deviceId: 'd', subscription: {} },
      { deviceId: 'd', subscription: { endpoint: nextEndpoint() } }]) {
      const check = store.validateSubscriptionInput(input);
      assert.equal(check.ok, false);
      assert.ok(check.error, '要给出中文说明，不能只是 false');
    }
  });
});

describe('upsert 语义（iOS 每次启动都会重报一次）', () => {
  it('同一个 endpoint 报两次只有一行，不报错', () => {
    const endpoint = nextEndpoint();
    const first = store.upsertSubscription({ userId: chen.id, deviceId: 'dev-a', endpoint, ...realKeys() });
    const second = store.upsertSubscription({ userId: chen.id, deviceId: 'dev-a', endpoint, ...realKeys() });
    assert.equal(rowsOf(chen.id).length, 1, '重报不能变成两行');
    assert.equal(first.id, second.id, '还是原来那一行，不是删了重建');
  });

  it('第二次报上来的密钥会覆盖第一次的（不然拿旧公钥去加密，推过去解不开）', () => {
    const endpoint = nextEndpoint();
    store.upsertSubscription({ userId: chen.id, deviceId: 'dev-a', endpoint, ...realKeys() });
    const fresh = realKeys();
    store.upsertSubscription({ userId: chen.id, deviceId: 'dev-a', endpoint, ...fresh });
    const row = rowAt(endpoint);
    assert.equal(row.p256dh, fresh.p256dh);
    assert.equal(row.auth, fresh.auth);
  });

  it('同一个人的不同设备是两行（手机 + 平板各订各的）', () => {
    store.upsertSubscription({ userId: chen.id, deviceId: 'dev-iphone', endpoint: nextEndpoint(), ...realKeys() });
    store.upsertSubscription({ userId: chen.id, deviceId: 'dev-ipad', endpoint: nextEndpoint(), ...realKeys() });
    const rows = rowsOf(chen.id);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.device_id).sort(), ['dev-ipad', 'dev-iphone']);
  });

  it('重报会把 fail_count 和 last_ok_at 清干净（新密钥的成败与旧的无关）', () => {
    const endpoint = nextEndpoint();
    store.upsertSubscription({ userId: chen.id, deviceId: 'dev-a', endpoint, ...realKeys() });
    store.markPushResult(endpoint, true);
    store.markPushResult(endpoint, false);
    store.markPushResult(endpoint, false);
    assert.equal(rowAt(endpoint).fail_count, 2, '前提：失败确实累加上去了');

    store.upsertSubscription({ userId: chen.id, deviceId: 'dev-a', endpoint, ...realKeys() });
    assert.equal(rowAt(endpoint).fail_count, 0);
    assert.equal(rowAt(endpoint).last_ok_at, null);
  });

  it('同一个人重报不刷新 created_at（那一列要能回答「这台设备什么时候开的通知」）', () => {
    const endpoint = nextEndpoint();
    store.upsertSubscription({ userId: chen.id, deviceId: 'dev-a', endpoint, ...realKeys() });
    const originally = rowAt(endpoint).created_at;
    db.run('UPDATE push_subscriptions SET created_at = ? WHERE endpoint = ?', originally - 86_400_000, endpoint);

    store.upsertSubscription({ userId: chen.id, deviceId: 'dev-a', endpoint, ...realKeys() });
    assert.equal(rowAt(endpoint).created_at, originally - 86_400_000, '同一个人重报不该把它刷成今天');
  });
});

describe('同一台设备换人登录（安全边界）', () => {
  it('周雨桐在陈子航用过的设备上订阅后，陈子航名下一条都不剩', () => {
    const endpoint = nextEndpoint();      // 浏览器给的 endpoint 与账号无关，换人登录还是这一个
    store.upsertSubscription({ userId: chen.id, deviceId: 'shared-phone', endpoint, ...realKeys() });
    assert.equal(rowsOf(chen.id).length, 1, '前提：陈子航先订上了');

    store.upsertSubscription({ userId: zhou.id, deviceId: 'shared-phone', endpoint, ...realKeys() });

    assert.equal(rowsOf(chen.id).length, 0, '旧的那个人必须一条都查不到，否则他继续收别人的消息摘要');
    assert.equal(rowsOf(zhou.id).length, 1);
    assert.equal(totalRows(), 1, '换人不是新增一行，是把同一行改了归属');
  });

  it('subscriptionsFor 也只把它算给新的那个人', () => {
    const endpoint = nextEndpoint();
    store.upsertSubscription({ userId: chen.id, deviceId: 'shared-phone', endpoint, ...realKeys() });
    store.upsertSubscription({ userId: zhou.id, deviceId: 'shared-phone', endpoint, ...realKeys() });

    assert.deepEqual(store.subscriptionsFor([chen.id]), []);
    assert.equal(store.subscriptionsFor([zhou.id]).length, 1);
    // 一次查两个人也只能出一条——同一个 endpoint 不该在群发时被推两遍。
    assert.equal(store.subscriptionsFor([chen.id, zhou.id]).length, 1);
  });

  it('换人时 created_at 会重置（这一行的归属变了，旧时间没有意义）', () => {
    const endpoint = nextEndpoint();
    store.upsertSubscription({ userId: chen.id, deviceId: 'shared-phone', endpoint, ...realKeys() });
    db.run('UPDATE push_subscriptions SET created_at = 1 WHERE endpoint = ?', endpoint);
    store.upsertSubscription({ userId: zhou.id, deviceId: 'shared-phone', endpoint, ...realKeys() });
    assert.ok(rowAt(endpoint).created_at > 1, '换人之后 created_at 应当是这一次的时间');
  });
});

describe('push-store 的查询与删除', () => {
  it('subscriptionsFor 传空数组返回空数组，不会拼出 IN () 这种语法错误的 SQL', () => {
    assert.deepEqual(store.subscriptionsFor([]), []);
    assert.deepEqual(store.subscriptionsFor(), []);
    assert.deepEqual(store.subscriptionsFor([null, undefined, '']), []);
  });

  it('subscriptionsFor 给出 2C 要的字段，并且不带 ua / fail_count 这些内部列', () => {
    const endpoint = nextEndpoint();
    store.upsertSubscription({ userId: chen.id, deviceId: 'dev-a', endpoint, ...realKeys(), ua: 'iPhone' });
    const [sub] = store.subscriptionsFor([chen.id]);
    assert.deepEqual(Object.keys(sub).sort(), ['auth', 'deviceId', 'endpoint', 'id', 'p256dh', 'userId']);
    assert.equal(sub.userId, chen.id);
    assert.equal(sub.deviceId, 'dev-a');
    assert.equal(sub.endpoint, endpoint);
  });

  it('deleteSubscriptionForUser 只删自己那条，同一个人的其它设备不受影响', () => {
    const phone = nextEndpoint();
    const pad = nextEndpoint();
    store.upsertSubscription({ userId: chen.id, deviceId: 'dev-iphone', endpoint: phone, ...realKeys() });
    store.upsertSubscription({ userId: chen.id, deviceId: 'dev-ipad', endpoint: pad, ...realKeys() });

    assert.equal(store.deleteSubscriptionForUser(phone, chen.id), true);
    const left = rowsOf(chen.id);
    assert.equal(left.length, 1, '在手机上关通知不该把平板上的也关了');
    assert.equal(left[0].endpoint, pad);
  });

  it('deleteSubscriptionForUser 删不掉别人的那条', () => {
    const zhous = nextEndpoint();
    store.upsertSubscription({ userId: zhou.id, deviceId: 'dev-z', endpoint: zhous, ...realKeys() });
    assert.equal(store.deleteSubscriptionForUser(zhous, chen.id), false);
    assert.equal(rowsOf(zhou.id).length, 1, '周雨桐的订阅必须还在');
  });

  it('deleteSubscription（不看归属）是给「推送服务说这个 endpoint 没了」用的', () => {
    const gone = nextEndpoint();
    store.upsertSubscription({ userId: zhou.id, deviceId: 'dev-z', endpoint: gone, ...realKeys() });
    assert.equal(store.deleteSubscription(gone), true);
    assert.equal(store.deleteSubscription(gone), false, '删过一次之后再删是 false，不是报错');
  });

  it('deleteSubscriptionsForUser 清光一个人的全部设备，别人的一条不动', () => {
    store.upsertSubscription({ userId: chen.id, deviceId: 'a', endpoint: nextEndpoint(), ...realKeys() });
    store.upsertSubscription({ userId: chen.id, deviceId: 'b', endpoint: nextEndpoint(), ...realKeys() });
    store.upsertSubscription({ userId: zhou.id, deviceId: 'c', endpoint: nextEndpoint(), ...realKeys() });

    assert.equal(store.deleteSubscriptionsForUser(chen.id), 2, '返回删掉的行数');
    assert.equal(rowsOf(chen.id).length, 0);
    assert.equal(rowsOf(zhou.id).length, 1);
  });

  it('markPushResult：成功清零并写 last_ok_at，失败只累加计数', () => {
    const endpoint = nextEndpoint();
    store.upsertSubscription({ userId: chen.id, deviceId: 'a', endpoint, ...realKeys() });

    store.markPushResult(endpoint, false);
    store.markPushResult(endpoint, false);
    assert.equal(rowAt(endpoint).fail_count, 2);
    assert.equal(rowAt(endpoint).last_ok_at, null, '一次都没成功过就不该有 last_ok_at');

    store.markPushResult(endpoint, true);
    assert.equal(rowAt(endpoint).fail_count, 0);
    assert.ok(rowAt(endpoint).last_ok_at > 0);

    assert.equal(store.markPushResult(nextEndpoint(), true), false, '库里没这一行时返回 false，不抛');
  });
});

describe('接口鉴权', () => {
  it('三个接口不带 token 一律 401', async () => {
    for (const [method, path, body] of [
      ['GET', '/api/push/config', undefined],
      ['POST', '/api/push/subscribe', payload()],
      ['DELETE', '/api/push/subscribe', { endpoint: nextEndpoint() }],
    ]) {
      const res = await push.call(method, path, { body });
      assert.equal(res.status, 401, `${method} ${path} 应当 401`);
    }
    assert.equal(totalRows(), 0, '未登录的上报一条都不该入库');
  });

  it('拿一张伪造的 token 同样进不来', async () => {
    const res = await push.call('POST', '/api/push/subscribe', { token: 'not-a-jwt', body: payload() });
    assert.equal(res.status, 401);
    assert.equal(totalRows(), 0);
  });
});

describe('POST /api/push/subscribe', () => {
  it('合法上报返回 201，库里多一行，归属是登录的那个人', async () => {
    const body = payload('dev-iphone');
    const res = await push.call('POST', '/api/push/subscribe', { token: chenToken, body });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { ok: true });

    const row = rowAt(body.subscription.endpoint);
    assert.equal(row.user_id, chen.id);
    assert.equal(row.device_id, 'dev-iphone');
    assert.equal(row.p256dh, body.subscription.keys.p256dh);
  });

  it('同一份上报连发两次还是 201，还是一行（iOS 每次启动都会来这么一次）', async () => {
    const body = payload('dev-iphone');
    const first = await push.call('POST', '/api/push/subscribe', { token: chenToken, body });
    const second = await push.call('POST', '/api/push/subscribe', { token: chenToken, body });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201, '「已经有了」不是错误，不能回 409');
    assert.equal(totalRows(), 1);
  });

  it('请求体里塞 userId 想挂到别人头上，一点用都没有', async () => {
    const body = { ...payload('dev-x'), userId: zhou.id, user_id: zhou.id };
    await push.call('POST', '/api/push/subscribe', { token: chenToken, body });
    assert.equal(rowsOf(zhou.id).length, 0, '归属只能来自 token');
    assert.equal(rowsOf(chen.id).length, 1);
  });

  it('User-Agent 只留前 120 字符', async () => {
    const body = payload('dev-x');
    await push.call('POST', '/api/push/subscribe', {
      token: chenToken, body, headers: { 'User-Agent': 'M'.repeat(300) },
    });
    assert.equal(rowAt(body.subscription.endpoint).ua.length, 120);
  });

  it('非法的 p256dh / auth / endpoint / deviceId 一律 400，而且一条都不入库', async () => {
    const good = payload();
    const bad = [
      ['p256dh 太短', { ...good, subscription: { ...good.subscription, keys: { p256dh: 'AAAA', auth: good.subscription.keys.auth } } }],
      ['auth 太短', { ...good, subscription: { ...good.subscription, keys: { p256dh: good.subscription.keys.p256dh, auth: 'AA' } } }],
      ['endpoint 是 http', { ...good, subscription: { ...good.subscription, endpoint: 'http://web.push.apple.com/x' } }],
      ['endpoint 不是 URL', { ...good, subscription: { ...good.subscription, endpoint: '随便写的' } }],
      ['没有 deviceId', { subscription: good.subscription }],
      ['空请求体', {}],
    ];
    for (const [label, body] of bad) {
      const res = await push.call('POST', '/api/push/subscribe', { token: chenToken, body });
      assert.equal(res.status, 400, `${label} 应当 400，实际 ${res.status}`);
      assert.ok(res.body?.error, `${label} 要给出中文原因`);
    }
    assert.equal(totalRows(), 0, '坏数据一行都不该进库');
  });
});

describe('DELETE /api/push/subscribe', () => {
  it('删自己的那条：204，库里没了', async () => {
    const body = payload('dev-iphone');
    await push.call('POST', '/api/push/subscribe', { token: chenToken, body });

    const res = await push.call('DELETE', '/api/push/subscribe', {
      token: chenToken, body: { endpoint: body.subscription.endpoint },
    });
    assert.equal(res.status, 204);
    assert.equal(res.raw, '', '204 不该带响应体');
    assert.equal(rowsOf(chen.id).length, 0);
  });

  it('只删指定的那个 endpoint，同一个人的其它设备照旧', async () => {
    const phone = payload('dev-iphone');
    const pad = payload('dev-ipad');
    await push.call('POST', '/api/push/subscribe', { token: chenToken, body: phone });
    await push.call('POST', '/api/push/subscribe', { token: chenToken, body: pad });

    await push.call('DELETE', '/api/push/subscribe', {
      token: chenToken, body: { endpoint: phone.subscription.endpoint },
    });
    const left = rowsOf(chen.id);
    assert.equal(left.length, 1);
    assert.equal(left[0].endpoint, pad.subscription.endpoint);
  });

  it('拿别人的 endpoint 来删，删不掉——而且响应与「这个 endpoint 压根不存在」逐字相同', async () => {
    const zhous = payload('dev-zhou');
    await push.call('POST', '/api/push/subscribe', { token: zhouToken, body: zhous });

    const stealing = await push.call('DELETE', '/api/push/subscribe', {
      token: chenToken, body: { endpoint: zhous.subscription.endpoint },
    });
    const nonexistent = await push.call('DELETE', '/api/push/subscribe', {
      token: chenToken, body: { endpoint: nextEndpoint() },
    });

    assert.equal(rowsOf(zhou.id).length, 1, '周雨桐的推送不能被陈子航关掉');
    // 两种情况必须是同一种响应：分开说等于把这个接口变成「某个 endpoint 在不在库里」的探针。
    assert.equal(stealing.status, nonexistent.status);
    assert.equal(stealing.raw, nonexistent.raw);
    assert.equal(stealing.status, 204);
  });

  it('重复退订同一个 endpoint 也是 204（前端可以无脑重试）', async () => {
    const body = payload();
    await push.call('POST', '/api/push/subscribe', { token: chenToken, body });
    const endpoint = body.subscription.endpoint;
    const first = await push.call('DELETE', '/api/push/subscribe', { token: chenToken, body: { endpoint } });
    const second = await push.call('DELETE', '/api/push/subscribe', { token: chenToken, body: { endpoint } });
    assert.equal(first.status, 204);
    assert.equal(second.status, 204);
  });

  it('不带 endpoint 是 400（这不是「删不到」，是调用方漏了参数）', async () => {
    for (const body of [{}, { endpoint: '' }, { endpoint: '   ' }, { endpoint: 42 }]) {
      const res = await push.call('DELETE', '/api/push/subscribe', { token: chenToken, body });
      assert.equal(res.status, 400, `${JSON.stringify(body)} 应当 400`);
    }
  });
});

describe('GET /api/push/config', () => {
  it('没接上 VAPID 自检时是「未启用」，公钥为 null', async () => {
    const res = await push.call('GET', '/api/push/config', { token: chenToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { enabled: false, publicKey: null });
  });

  it('2E 接上自检结果之后，公钥发得出去', async () => {
    const { setPushConfigProvider } = await import('../src/routes/push.js');
    setPushConfigProvider(() => ({ enabled: true, publicKey: 'BFakePublicKey' }));
    try {
      const res = await push.call('GET', '/api/push/config', { token: chenToken });
      assert.deepEqual(res.body, { enabled: true, publicKey: 'BFakePublicKey' });
    } finally {
      setPushConfigProvider(null);
    }
  });

  it('自检说没启用时，即使配置里带着公钥也不发出去', async () => {
    const { setPushConfigProvider } = await import('../src/routes/push.js');
    setPushConfigProvider(() => ({ enabled: false, publicKey: 'BLeftoverKey' }));
    try {
      const res = await push.call('GET', '/api/push/config', { token: chenToken });
      assert.deepEqual(res.body, { enabled: false, publicKey: null });
    } finally {
      setPushConfigProvider(null);
    }
  });
});

describe('账号停用要连带清掉推送订阅', () => {
  it('停用之后该账号名下一条订阅都不剩，别人的一条不少', async () => {
    const victim = await member('待停用的人');
    const victimToken = await api.login(victim.email, PASSWORD);
    await push.call('POST', '/api/push/subscribe', { token: victimToken, body: payload('dev-phone') });
    await push.call('POST', '/api/push/subscribe', { token: victimToken, body: payload('dev-pad') });
    await push.call('POST', '/api/push/subscribe', { token: chenToken, body: payload('dev-chen') });
    assert.equal(rowsOf(victim.id).length, 2, '前提：他确实在两台设备上开了通知');

    const res = await api.post(`/api/users/${victim.id}/disable`, {}, adminToken);
    assert.equal(res.status, 200);

    // disconnect() 掐掉的只是 SSE；推送是苹果/谷歌直接投到手机上的另一条通道，
    // 不显式删的话，被停用的人会继续在锁屏上看到消息标题和摘要。
    assert.equal(rowsOf(victim.id).length, 0, '停用的人必须收不到推送了');
    assert.equal(rowsOf(chen.id).length, 1, '不能连别人的一起清了');
  });

  it('停用之后他也没法再把订阅报回来（authenticate 那一层就挡住了）', async () => {
    const victim = await member('停用后再报的人');
    const victimToken = await api.login(victim.email, PASSWORD);
    await api.post(`/api/users/${victim.id}/disable`, {}, adminToken);

    const res = await push.call('POST', '/api/push/subscribe', { token: victimToken, body: payload() });
    assert.equal(res.status, 401);
    assert.equal(rowsOf(victim.id).length, 0);
  });

  it('恢复账号不会把订阅变回来——他要在每台设备上重新开一次通知', async () => {
    const victim = await member('停了又恢复的人');
    const victimToken = await api.login(victim.email, PASSWORD);
    await push.call('POST', '/api/push/subscribe', { token: victimToken, body: payload() });
    await api.post(`/api/users/${victim.id}/disable`, {}, adminToken);
    await api.post(`/api/users/${victim.id}/enable`, {}, adminToken);
    assert.equal(rowsOf(victim.id).length, 0, '订阅已经删了，恢复账号不该凭空变出来');
  });

  it('管理员重置密码**不**删订阅（人还是他自己，不该为此在每台设备上重开一次）', async () => {
    const target = await member('被重置密码的人');
    const targetToken = await api.login(target.email, PASSWORD);
    await push.call('POST', '/api/push/subscribe', { token: targetToken, body: payload() });
    assert.equal(rowsOf(target.id).length, 1);

    const res = await api.post(`/api/users/${target.id}/reset-password`, {}, adminToken);
    assert.equal(res.status, 200);
    assert.equal(rowsOf(target.id).length, 1, '改密码只作废凭据，订阅要留着');
  });
});
