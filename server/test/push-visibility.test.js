// 「切后台后立刻发的消息收不到推送」——真机 bug 的回归用例与全部边界。
//
// ── 病历（真机反馈，不是设想）───────────────────────────────────────────────
//
// iPhone 上 PWA 还在前台 → 立即切后台 → 马上让别人发消息 → **没有推送**。
// 等久一点再发就有。
//
// 根因：服务端判「这台设备在不在线」，依据是 SSE 连接还在不在 `clients` 里，而连接只在
// `res.on('close')` 时才摘掉。**iOS 挂起 PWA 时 TCP 通常不会立刻断**，`res.write(': ping')`
// 还能往内核缓冲区里写成功，于是服务端好几分钟都以为那台在线，push-decide 直接跳过它
// ——一个字节都没发给苹果。
//
// 旧代码把这个窗口写成「TCP 半开，最坏等 25 秒心跳」，**低估了**：拔网线是链路真的断了，
// 而 iOS 冻结页面时链路好端端的，socket 在很长时间里都是「可写」的，心跳压根不会失败。
//
// 修法：页面在被冻结之前一定会收到 `visibilitychange`，那一刻用 `fetch(keepalive)` 报一句
// 「我切后台了」（web/src/lib/visibility.ts），服务端记下来，不再从连接的存在去推断。
//
// ── 这个文件里最重要的一条 ────────────────────────────────────────────────
//
// 「设备连着 SSE 但报告了后台 → 必须推」。看上去像 bug（连着还推？），其实正是修复本身。
// 谁想把它改回「连着就不推」，请先在 iPhone 上复现一遍上面那段病历。
import './helpers.js';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, waitFor } from './helpers.js';
import { group, member } from './fixtures.js';
import { foregroundDeviceIds } from '../src/events.js';
import { setPushBridgeForTests } from '../src/push-decide.js';
import { resetVisibilityLimit } from '../src/routes/push.js';

let api;
let admin;

before(async () => {
  api = await startServer();
  admin = await api.loginAdmin();
});
after(() => {
  setPushBridgeForTests(undefined);
  return api.close();
});
afterEach(() => resetVisibilityLimit());

/** 开一条真的 SSE 连接。返回 close()。 */
async function openStream(token, device, stream) {
  const ac = new AbortController();
  const query = `&device=${encodeURIComponent(device)}`
    + (stream === undefined ? '' : `&stream=${encodeURIComponent(stream)}`);
  const res = await fetch(`${api.baseUrl}/api/stream?token=${token}${query}`, { signal: ac.signal });
  assert.equal(res.status, 200);
  // 必须把 body 读起来，否则 node 不会把这条响应当成活跃连接。
  const reader = res.body.getReader();
  let text = '';
  const decoder = new TextDecoder();
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch { /* abort 时抛，正常 */ }
  })();
  return { close: () => ac.abort(), text: () => text };
}

/** 走真的 HTTP 接口报一次可见性。 */
const report = (token, deviceId, streamId, visible) =>
  api.post('/api/push/visibility', { deviceId, streamId, visible }, token);

/** 一条订阅（形状同 push-store 读出来的那份）。 */
const subFor = (user, deviceId) => ({
  id: `ps_${user.id}_${deviceId}`,
  userId: user.id,
  deviceId,
  endpoint: `https://push.example.com/${user.id}/${deviceId}`,
  p256dh: 'p',
  auth: 'a',
});

let sent;

/** 装一座假的推送桥，`sent` 里攒下真的发出去的每一条。 */
function fakeBridge(subscriptions) {
  sent = [];
  setPushBridgeForTests({
    subscriptionsFor: async (userIds) => subscriptions.filter((s) => userIds.includes(s.userId)),
    sendPush: async ({ subscription, payload }) => {
      sent.push({ deviceId: subscription.deviceId, payload: JSON.parse(payload) });
      return { ok: true, status: 201 };
    },
    deleteSubscription: async () => {},
    markPushResult: async () => {},
  });
}

/** 推送是「响应之后」才发的，给它一点时间冒出来，然后断言一条都没有。 */
async function assertNoPush() {
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(sent, [], `不该推却推了：${JSON.stringify(sent)}`);
}

// ---------------------------------------------------------------------------

describe('真机 bug 回归：连着 SSE 但报告了后台 → 必须推', () => {
  it('SSE 还连着（iOS 冻结时 TCP 不会断），只要报了后台就照推', async () => {
    // ⚠️⚠️ 这就是那个真机场景，一个字都别改宽松：
    //   iPhone 上 PWA 还在前台 → 立即切后台 → 马上让别人发消息。
    // 「切后台」那一刻 iOS 只是冻结了页面，**TCP 连接还活着**（下面这条 SSE 就是它），
    // 所以判据绝不能是「连接在不在」。这条用例里连接自始至终没断过，推送必须照发。
    const shou = await member('切后台的');
    const token = await api.login(shou.email);
    const g = await group(api, admin, '切后台组', [shou.id]);
    fakeBridge([subFor(shou, 'iphone')]);

    const stream = await openStream(token, 'iphone', 'tab-1');
    try {
      // 先像刚打开 App 那样报一次前台，再像切后台那样报一次后台。
      assert.equal((await report(token, 'iphone', 'tab-1', true)).status, 200);
      await waitFor(() => foregroundDeviceIds(shou.id).has('iphone'));
      assert.equal((await report(token, 'iphone', 'tab-1', false)).status, 200);

      assert.equal(
        (await api.post(`/api/conversations/${g.id}/messages`, { body: '在吗' }, admin)).status,
        201,
      );
      await waitFor(() => sent.length === 1);
      assert.deepEqual(sent.map((s) => s.deviceId), ['iphone']);
    } finally {
      stream.close();
    }
  });

  it('反过来：同一台设备报了前台就不推（这条保证上一条不是「永远都推」）', async () => {
    const kan = await member('正看着的');
    const token = await api.login(kan.email);
    const g = await group(api, admin, '正看着组', [kan.id]);
    fakeBridge([subFor(kan, 'iphone')]);

    const stream = await openStream(token, 'iphone', 'tab-1');
    try {
      assert.equal((await report(token, 'iphone', 'tab-1', true)).status, 200);
      await waitFor(() => foregroundDeviceIds(kan.id).has('iphone'));
      assert.equal(
        (await api.post(`/api/conversations/${g.id}/messages`, { body: '在吗' }, admin)).status,
        201,
      );
      await assertNoPush();
    } finally {
      stream.close();
    }
  });
});

describe('边界 1 · 上报失败 / 从来没报过：默认偏向「推」', () => {
  it('连着 SSE、但一次都没报过 → 照推（网络抖掉了那一发，或者老客户端）', async () => {
    // 上报请求失败没有别的补救，唯一能保证安全的是**默认值站在哪一边**。
    // 判定原则「宁可多推一条，不可漏推」在这里的落法：不知道这台设备什么状态，就推。
    // 默认成「前台」的话，一次丢包就能让一台设备从此静默，而且没有任何报错。
    const mo = await member('没报过的');
    const token = await api.login(mo.email);
    const g = await group(api, admin, '没报过组', [mo.id]);
    fakeBridge([subFor(mo, 'phone')]);

    const stream = await openStream(token, 'phone', 'tab-1');
    try {
      await waitFor(() => stream.text().includes(': connected'));
      assert.deepEqual([...foregroundDeviceIds(mo.id)], [], '没报过就不该出现在前台集合里');
      assert.equal(
        (await api.post(`/api/conversations/${g.id}/messages`, { body: '喂' }, admin)).status,
        201,
      );
      await waitFor(() => sent.length === 1);
    } finally {
      stream.close();
    }
  });

  it('上报没命中任何连接（页面还没建 SSE）不是错误：200 + connections: 0，设备仍算后台', async () => {
    const zao = await member('报早了');
    const token = await api.login(zao.email);
    const res = await report(token, 'phone', 'tab-1', true);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, connections: 0 });
    assert.deepEqual([...foregroundDeviceIds(zao.id)], []);
  });
});

describe('边界 2 · SSE 断开，可见性状态跟着一起没', () => {
  it('报了前台之后把连接断掉 → 立刻回到「后台」，下一条消息就推', async () => {
    // 不清的话残留的是**「前台」**这个状态——最坏的那个方向：用户关掉浏览器之后，
    // 服务端仍然认为那台机器上有人看着，于是从此再也不给它推，而且没有任何报错。
    // 这里把状态挂在连接上，连接一没它自动跟着没，结构上不可能残留。
    const guan = await member('关页面的');
    const token = await api.login(guan.email);
    const g = await group(api, admin, '关页面组', [guan.id]);
    fakeBridge([subFor(guan, 'laptop')]);

    const stream = await openStream(token, 'laptop', 'tab-1');
    assert.equal((await report(token, 'laptop', 'tab-1', true)).status, 200);
    await waitFor(() => foregroundDeviceIds(guan.id).has('laptop'));

    stream.close();
    await waitFor(() => !foregroundDeviceIds(guan.id).has('laptop'));

    assert.equal(
      (await api.post(`/api/conversations/${g.id}/messages`, { body: '人呢' }, admin)).status,
      201,
    );
    await waitFor(() => sent.length === 1);
  });

  it('同一台设备、同一个 streamId 重新连上来，也是从「后台」起步', async () => {
    // 断线重连拿到的是一条全新的连接，服务端这边是一张白纸。前端因此要在 onOpen 里
    // 把可见性重报一遍（web/src/lib/useStream.ts），不重报就该按后台算。
    const chong = await member('重连的页面');
    const token = await api.login(chong.email);

    const first = await openStream(token, 'laptop', 'tab-1');
    assert.equal((await report(token, 'laptop', 'tab-1', true)).status, 200);
    await waitFor(() => foregroundDeviceIds(chong.id).has('laptop'));
    first.close();
    await waitFor(() => !foregroundDeviceIds(chong.id).has('laptop'));

    const second = await openStream(token, 'laptop', 'tab-1');
    try {
      await waitFor(() => second.text().includes(': connected'));
      assert.deepEqual([...foregroundDeviceIds(chong.id)], [], '新连接不该继承上一条的前台状态');
    } finally {
      second.close();
    }
  });
});

describe('边界 3 · 同一台设备开两个标签页', () => {
  it('甲可见、乙切走 → 这台设备仍算前台，不推', async () => {
    // 两个标签页共用一个 deviceId（localStorage 按源存）和一条推送订阅，所以「推不推」
    // 是设备级的问题。人确实正盯着甲看，这台机器不该再冒推送。
    // 靠 streamId 把两条连接分开记；只按 deviceId 记的话，乙的「后台」会盖掉甲的「前台」。
    const liang = await member('两个标签页');
    const token = await api.login(liang.email);
    const g = await group(api, admin, '两标签组', [liang.id]);
    fakeBridge([subFor(liang, 'desktop')]);

    const a = await openStream(token, 'desktop', 'tab-a');
    const b = await openStream(token, 'desktop', 'tab-b');
    try {
      assert.equal((await report(token, 'desktop', 'tab-a', true)).status, 200);
      assert.equal((await report(token, 'desktop', 'tab-b', true)).status, 200);
      // 乙切走了，甲还开着。
      assert.equal((await report(token, 'desktop', 'tab-b', false)).status, 200);
      assert.deepEqual([...foregroundDeviceIds(liang.id)], ['desktop']);

      assert.equal(
        (await api.post(`/api/conversations/${g.id}/messages`, { body: '甲还看着呢' }, admin)).status,
        201,
      );
      await assertNoPush();
    } finally {
      a.close();
      b.close();
    }
  });

  it('两个都切走了才算后台 → 这时候要推', async () => {
    const dou = await member('两个都切走');
    const token = await api.login(dou.email);
    const g = await group(api, admin, '都切走组', [dou.id]);
    fakeBridge([subFor(dou, 'desktop')]);

    const a = await openStream(token, 'desktop', 'tab-a');
    const b = await openStream(token, 'desktop', 'tab-b');
    try {
      assert.equal((await report(token, 'desktop', 'tab-a', true)).status, 200);
      assert.equal((await report(token, 'desktop', 'tab-b', true)).status, 200);
      assert.equal((await report(token, 'desktop', 'tab-a', false)).status, 200);
      assert.equal((await report(token, 'desktop', 'tab-b', false)).status, 200);
      assert.deepEqual([...foregroundDeviceIds(dou.id)], []);

      assert.equal(
        (await api.post(`/api/conversations/${g.id}/messages`, { body: '都走了吧' }, admin)).status,
        201,
      );
      await waitFor(() => sent.length === 1);
    } finally {
      a.close();
      b.close();
    }
  });

  it('关掉可见的那个标签页，另一个还在后台 → 这台设备回到后台', async () => {
    // 上一条的补充：让「甲可见」这个状态随着甲的连接一起消失，而不是靠甲在关闭前
    // 补报一句「我不可见了」——那一发是可能丢的，而丢了就是漏推。
    const guan = await member('关掉可见那个');
    const token = await api.login(guan.email);

    const a = await openStream(token, 'desktop', 'tab-a');
    const b = await openStream(token, 'desktop', 'tab-b');
    try {
      assert.equal((await report(token, 'desktop', 'tab-a', true)).status, 200);
      assert.equal((await report(token, 'desktop', 'tab-b', false)).status, 200);
      assert.deepEqual([...foregroundDeviceIds(guan.id)], ['desktop']);

      a.close();   // 甲关了，一句话都没留下
      await waitFor(() => foregroundDeviceIds(guan.id).size === 0);
    } finally {
      b.close();
    }
  });
});

describe('边界 4 · 上报接口限流', () => {
  it('连发到超限会 429，而且**把这台设备踩成后台**（失败方向永远偏向多推）', async () => {
    // visibilitychange 在某些浏览器上切一次窗口会连发好几发，所以要限。
    // 但限流不能简单地「把这一发丢掉」：丢掉的如果正好是那句「我切后台了」，
    // 服务端就永远停在前台上，这台设备从此收不到推送——正是本次要修的 bug。
    const kuang = await member('狂点的');
    const token = await api.login(kuang.email);
    const stream = await openStream(token, 'phone', 'tab-1');
    try {
      assert.equal((await report(token, 'phone', 'tab-1', true)).status, 200);
      await waitFor(() => foregroundDeviceIds(kuang.id).has('phone'));

      let limited = 0;
      for (let i = 0; i < 40; i += 1) {
        const res = await report(token, 'phone', 'tab-1', true);
        if (res.status === 429) limited += 1;
      }
      assert.ok(limited > 0, '连发 41 次都没被限流，限流没生效');
      assert.deepEqual(
        [...foregroundDeviceIds(kuang.id)], [],
        '被限流之后这台设备必须回到「后台」——状态不明就该推',
      );
    } finally {
      stream.close();
    }
  });

  it('正常节奏（切几次窗口）一次都不该被限', async () => {
    // 限流的窗口要比任何真人操作都宽，否则它自己就成了故障源。
    const zheng = await member('正常切窗口');
    const token = await api.login(zheng.email);
    const stream = await openStream(token, 'phone', 'tab-1');
    try {
      for (let i = 0; i < 6; i += 1) {
        assert.equal((await report(token, 'phone', 'tab-1', i % 2 === 0)).status, 200);
      }
      assert.deepEqual([...foregroundDeviceIds(zheng.id)], [], '最后一发是 false，该落在后台');
    } finally {
      stream.close();
    }
  });

  it('限流按设备各算各的：一台被限不影响同一个人的另一台', async () => {
    const liang = await member('一人两台');
    const token = await api.login(liang.email);
    const a = await openStream(token, 'phone', 'tab-1');
    const b = await openStream(token, 'laptop', 'tab-2');
    try {
      for (let i = 0; i < 41; i += 1) await report(token, 'phone', 'tab-1', true);
      assert.equal((await report(token, 'laptop', 'tab-2', true)).status, 200);
      assert.deepEqual([...foregroundDeviceIds(liang.id)], ['laptop']);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe('边界 5 · 从来没报过的设备算后台', () => {
  it('一台报了前台、另一台从没报过 → 只推没报过的那台', async () => {
    // 老客户端（页面代码还没更新）永远不会调这个接口。它落在「后台」这一档：
    // 多收一条推送，而不是从此收不到。同一条消息在那台设备上会既有推送又有本地通知，
    // tag 相同会互相覆盖，代价是震两下——比漏推好得多，而且用户刷新一次页面就没了。
    const lao = await member('老客户端和新客户端');
    const token = await api.login(lao.email);
    const g = await group(api, admin, '新老混用组', [lao.id]);
    fakeBridge([subFor(lao, 'new-phone'), subFor(lao, 'old-laptop')]);

    const fresh = await openStream(token, 'new-phone', 'tab-1');
    const old = await openStream(token, 'old-laptop', undefined);   // 老客户端不带 ?stream=
    try {
      assert.equal((await report(token, 'new-phone', 'tab-1', true)).status, 200);
      await waitFor(() => foregroundDeviceIds(lao.id).has('new-phone'));

      assert.equal(
        (await api.post(`/api/conversations/${g.id}/messages`, { body: '新老混用' }, admin)).status,
        201,
      );
      await waitFor(() => sent.length === 1);
      await new Promise((r) => setTimeout(r, 150));   // 万一多推了，给它冒出来的时间
      assert.deepEqual(sent.map((s) => s.deviceId), ['old-laptop']);
    } finally {
      fresh.close();
      old.close();
    }
  });

  it('老客户端就算报了也命中不了：它的连接没有 streamId', async () => {
    const lao = await member('老连接');
    const token = await api.login(lao.email);
    const stream = await openStream(token, 'old-laptop', undefined);
    try {
      const res = await report(token, 'old-laptop', 'tab-1', true);
      assert.equal(res.status, 200);
      assert.equal(res.body.connections, 0);
      assert.deepEqual([...foregroundDeviceIds(lao.id)], []);
    } finally {
      stream.close();
    }
  });
});

describe('上报接口 · 鉴权与校验', () => {
  it('没登录一律 401', async () => {
    const res = await api.post('/api/push/visibility', { deviceId: 'd', streamId: 's', visible: true });
    assert.equal(res.status, 401);
  });

  it('只能改自己的设备：拿着别人的 deviceId / streamId 也改不动别人', async () => {
    // 命中是按 (userId, deviceId, streamId) 三元组做的，userId 一律取自凭据。
    // 少了这一层，任何登录用户猜到别人的 deviceId 就能把别人的设备标成「前台」，
    // 从而让那个人再也收不到推送——一个不响的静默 DoS。
    const shou = await member('受害者');
    const huai = await member('冒充者');
    const shouToken = await api.login(shou.email);
    const huaiToken = await api.login(huai.email);
    const g = await group(api, admin, '冒充组', [shou.id]);
    fakeBridge([subFor(shou, 'victim-phone')]);

    const stream = await openStream(shouToken, 'victim-phone', 'victim-tab');
    try {
      // 冒充者拿着受害者的 deviceId / streamId 报「前台」。
      const res = await report(huaiToken, 'victim-phone', 'victim-tab', true);
      assert.equal(res.status, 200);
      assert.equal(res.body.connections, 0, '改到别人的连接了');
      assert.deepEqual([...foregroundDeviceIds(shou.id)], [], '别人的设备被标成前台了');

      // 受害者照样收得到推送。
      assert.equal(
        (await api.post(`/api/conversations/${g.id}/messages`, { body: '你还在吗' }, admin)).status,
        201,
      );
      await waitFor(() => sent.length === 1);
    } finally {
      stream.close();
    }
  });

  const bad = {
    '缺 deviceId': { streamId: 's', visible: true },
    '缺 streamId': { deviceId: 'd', visible: true },
    'deviceId 是空串': { deviceId: '  ', streamId: 's', visible: true },
    'deviceId 超长': { deviceId: 'd'.repeat(129), streamId: 's', visible: true },
    'deviceId 带控制字符': { deviceId: 'd\u0001x', streamId: 's', visible: true },
    'visible 不是布尔': { deviceId: 'd', streamId: 's', visible: 'yes' },
    '缺 visible': { deviceId: 'd', streamId: 's' },
  };

  for (const [name, body] of Object.entries(bad)) {
    it(`400：${name}`, async () => {
      const token = await api.login((await member(`坏参数-${name}`)).email);
      const res = await api.post('/api/push/visibility', body, token);
      assert.equal(res.status, 400, JSON.stringify(res.body));
    });
  }

  it('合法的 UUID 形状要放行（带连字符，别被控制字符那道正则误伤）', async () => {
    const token = await api.login((await member('正经 UUID')).email);
    const res = await report(token, '3f1a9c22-0c1e-4a1f-9d3a-7c2b5e6f8a90', 'b7c8d9e0-1234-4567-89ab-cdef01234567', true);
    assert.equal(res.status, 200);
  });
});
