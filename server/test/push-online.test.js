// 「这台设备此刻在不在前台」——SSE 侧的真实行为。
//
// push-decide.test.js 验的是纯函数的判定；这里验的是喂给它的那个输入是不是真的对：
// 起一个真的 app，建几条带不同 ?device= / ?stream= 的 SSE 连接、走真的
// POST /api/push/visibility 报一下，看 foregroundDeviceIds 跟不跟得上。
// 按**设备**判而不是按人判是整个 2C 存在的理由（§C.3）。
//
// ⚠️ 判据在这一版变了：从「这台设备连着 SSE」变成「这台设备上有页面报告了自己在前台」。
//    连着 ≠ 在前台 —— iOS 冻结 PWA 时 TCP 不会断，服务端会一直以为它开着。
//    真机病历和边界逐条见 push-visibility.test.js 和 src/events.js。
import './helpers.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, waitFor } from './helpers.js';
import { direct, group, member } from './fixtures.js';
import { emitTo, foregroundDeviceIds } from '../src/events.js';
import { setPushBridgeForTests } from '../src/push-decide.js';
import { get } from '../src/db.js';
import { pushForMessage } from '../src/routes/conversations.js';

let api;
let admin;

before(async () => {
  api = await startServer();
  admin = await api.loginAdmin();
});
after(() => api.close());

/**
 * 开一条真的 SSE 连接，把收到的字节攒下来。
 * 返回 close()（断开）和 text()（到目前为止收到的原始流）。
 *
 * `stream` 是「这台设备上的哪一个页面」。默认按 `<device>-tab` 生成，只有专门要验
 * 「同一台设备两个标签页」的用例才需要自己指定。
 */
async function openStream(token, device, stream = device === undefined ? undefined : `${device}-tab`) {
  const ac = new AbortController();
  const query = (device === undefined ? '' : `&device=${device}`)
    + (stream === undefined ? '' : `&stream=${stream}`);
  const res = await fetch(`${api.baseUrl}/api/stream?token=${token}${query}`, { signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch { /* abort 时抛，正常 */ }
  })();
  return { close: () => ac.abort(), text: () => text, device, stream };
}

/** 走真的 HTTP 接口报一次可见性，不绕过鉴权和校验。 */
const report = (token, device, stream, visible) =>
  api.post('/api/push/visibility', { deviceId: device, streamId: stream, visible }, token);

/**
 * 开一条 SSE 连接**并报告这个页面在前台**——也就是「用户正开着这台设备上的网页」。
 *
 * 建连本身不再等于前台（见文件头 ⚠️），所以凡是想造出「这台设备在前台」这个状态的
 * 用例，都得走这个函数，光 openStream 是不够的。
 */
async function openForeground(token, device, stream = `${device}-tab`) {
  const s = await openStream(token, device, stream);
  assert.equal((await report(token, device, stream, true)).status, 200);
  return s;
}

describe('前台设备 · 按设备记，不按人记', () => {
  it('两台设备各连一条、各报一次前台，两个 deviceId 都在集合里', async () => {
    const you = await member('尤两台');
    const token = await api.login(you.email);
    const laptop = await openForeground(token, 'laptop');
    const phone = await openForeground(token, 'phone');
    try {
      await waitFor(() => foregroundDeviceIds(you.id).size === 2);
      assert.deepEqual([...foregroundDeviceIds(you.id)].sort(), ['laptop', 'phone']);
    } finally {
      laptop.close();
      phone.close();
    }
  });

  it('断开其中一条，集合跟着少一个；另一条不受影响', async () => {
    const duan = await member('段掉一条');
    const token = await api.login(duan.email);
    const laptop = await openForeground(token, 'laptop');
    const phone = await openForeground(token, 'phone');
    try {
      await waitFor(() => foregroundDeviceIds(duan.id).size === 2);
      laptop.close();
      // 断开方向**不做任何宽限期**：连接一没，下一条消息就该推到那台设备上（§C.4）。
      await waitFor(() => !foregroundDeviceIds(duan.id).has('laptop'));
      assert.deepEqual([...foregroundDeviceIds(duan.id)], ['phone']);
    } finally {
      phone.close();
    }
  });

  it('全断开之后集合是空的', async () => {
    const quan = await member('全断了');
    const token = await api.login(quan.email);
    const one = await openForeground(token, 'laptop');
    await waitFor(() => foregroundDeviceIds(quan.id).size === 1);
    one.close();
    await waitFor(() => foregroundDeviceIds(quan.id).size === 0);
    assert.deepEqual([...foregroundDeviceIds(quan.id)], []);
  });

  it('不带 device 的老客户端：连得上、收得到消息，但不进前台设备集合', async () => {
    // 这一条是兼容性底线。老页面不带 ?device= 就把它算成「没有已知设备」，
    // 于是它那台机器上的推送订阅（如果有）照推——宁可多推一条，不可漏推。
    const lao = await member('老客户端');
    const token = await api.login(lao.email);
    const stream = await openStream(token, undefined);
    try {
      await waitFor(() => stream.text().includes(': connected'));
      assert.deepEqual([...foregroundDeviceIds(lao.id)], []);
      emitTo([lao.id], 'ping-test', { hello: 1 });
      await waitFor(() => stream.text().includes('event: ping-test'));
      assert.match(stream.text(), /"hello":1/);
    } finally {
      stream.close();
    }
  });

  it('?device=a&device=b 这种数组形态一律当没带，不能崩', async () => {
    const guai = await member('怪参数');
    const token = await api.login(guai.email);
    const stream = await openStream(token, 'a&device=b');
    try {
      await waitFor(() => stream.text().includes(': connected'));
      assert.deepEqual([...foregroundDeviceIds(guai.id)], []);
    } finally {
      stream.close();
    }
  });

  it('同一台设备重连两次（旧连接还没断）只算一台', async () => {
    // 两条连接同一个 deviceId、不同的 streamId（两个标签页），各报各的前台。
    // 集合是按**设备**去重的，所以还是一台。
    const chong = await member('重连的');
    const token = await api.login(chong.email);
    const a = await openForeground(token, 'same-phone', 'tab-a');
    const b = await openForeground(token, 'same-phone', 'tab-b');
    try {
      await waitFor(() => foregroundDeviceIds(chong.id).size === 1);
      assert.deepEqual([...foregroundDeviceIds(chong.id)], ['same-phone']);
    } finally {
      a.close();
      b.close();
    }
  });

  it('各人算各人的：甲的设备不会出现在乙的集合里', async () => {
    const jia = await member('甲设备');
    const yi = await member('乙设备');
    const sa = await openForeground(await api.login(jia.email), 'jia-phone');
    const sb = await openForeground(await api.login(yi.email), 'yi-phone');
    try {
      await waitFor(() => foregroundDeviceIds(jia.id).size === 1 && foregroundDeviceIds(yi.id).size === 1);
      assert.deepEqual([...foregroundDeviceIds(jia.id)], ['jia-phone']);
      assert.deepEqual([...foregroundDeviceIds(yi.id)], ['yi-phone']);
    } finally {
      sa.close();
      sb.close();
    }
  });

  it('没连过的人查出来是空集合，不是 undefined', async () => {
    assert.deepEqual([...foregroundDeviceIds('u_从来没连过')], []);
  });
});

describe('连接表换了两轮之后，原有行为一个字都没变', () => {
  it('消息照样从 SSE 推到每一台连着的设备上', async () => {
    // clients 先从 Set<res> 换成 Map<res, deviceId>，这一版又把值换成了一个对象
    //（deviceId + streamId + foreground）。遍历写法必须走 .keys()：写漏一个的话，
    // emitTo 会把 [res, state] 这个数组当成 res 去 write，整个实时通道静默全废。
    const shou = await member('收消息的');
    const token = await api.login(shou.email);
    const dm = await direct(api, token, (await member('发消息的')).id);
    const laptop = await openForeground(token, 'laptop');
    const phone = await openForeground(token, 'phone');
    try {
      await waitFor(() => foregroundDeviceIds(shou.id).size === 2);
      const sent = await api.post(`/api/conversations/${dm.id}/messages`, { body: '两台都该收到' }, token);
      assert.equal(sent.status, 201);
      await waitFor(() => laptop.text().includes('两台都该收到') && phone.text().includes('两台都该收到'));
      assert.match(laptop.text(), /event: message/);
      assert.match(phone.text(), /event: message/);
    } finally {
      laptop.close();
      phone.close();
    }
  });

  it('停用账号仍然当场掐断全部连接', async () => {
    const ting = await member('停用的');
    const token = await api.login(ting.email);
    const stream = await openForeground(token, 'phone');
    await waitFor(() => foregroundDeviceIds(ting.id).size === 1);
    assert.equal((await api.post(`/api/users/${ting.id}/disable`, {}, admin)).status, 200);
    await waitFor(() => foregroundDeviceIds(ting.id).size === 0);
    assert.deepEqual([...foregroundDeviceIds(ting.id)], []);
    stream.close();
  });
});

describe('推送失败不许影响发消息', () => {
  it('推送模块整个不在（2A / 2B 还没合进来），发消息照样 201、照样入库', async () => {
    // 这一条锁的是 push-decide.js 那段动态 import 的兜底：顶部写成静态 import 的话，
    // 缺文件会在模块加载期就把 routes/conversations.js 一起带崩，发消息这条主链路就没了。
    const rejections = [];
    const catchIt = (err) => rejections.push(err);
    process.on('unhandledRejection', catchIt);
    try {
      const fa = await member('发消息不受影响');
      const token = await api.login(fa.email);
      const dm = await direct(api, token, (await member('对面那位')).id);
      const sent = await api.post(`/api/conversations/${dm.id}/messages`, { body: '推送不通也得发出去' }, token);
      assert.equal(sent.status, 201);

      // 真的落库了，不只是响应好看。
      const row = get('SELECT body FROM messages WHERE id = ?', sent.body.message.id);
      assert.equal(row.body, '推送不通也得发出去');

      // 给「响应之后那一段」留出时间，看有没有 rejection 漏出来。
      // 漏出来的话在生产上就是 Express 5 的 ERR_HTTP_HEADERS_SENT 噪音（issue #19）。
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(rejections, []);
    } finally {
      process.off('unhandledRejection', catchIt);
    }
  });

  it('推送链路当场抛异常，pushForMessage 也不往外抛一个字', async () => {
    // 调用点在 res.json() 之后。这里直接拿真的会话和真的消息去撞，
    // 注入一个必炸的 subscriptionsFor —— 函数必须同步返回、异常只进日志回调。
    const bao = await member('推送炸了');
    const g = await group(api, admin, '炸群', [bao.id]);
    // 管理员发、bao 收：收件人不能是发送者本人，否则规则 2 会在查订阅之前就把他筛掉。
    const sent = await api.post(`/api/conversations/${g.id}/messages`, { body: '这条要正常发出去' }, admin);
    assert.equal(sent.status, 201);

    const convo = get('SELECT * FROM conversations WHERE id = ?', g.id);
    const errs = [];
    assert.doesNotThrow(() => pushForMessage(convo, sent.body.message, [bao.id], {
      subscriptionsFor: async () => { throw new Error('推送服务炸了'); },
      send: async () => assert.fail('都炸了还发什么'),
      onError: (err) => errs.push(err.message),
    }));
    await waitFor(() => errs.length === 1);
    assert.deepEqual(errs, ['推送服务炸了']);
  });

  it('推送的正文和标题走的是真会话的真数据（群名带得上）', async () => {
    const zhen = await member('真数据');
    const g = await group(api, admin, '发版小组', [zhen.id]);
    const sent = await api.post(
      `/api/conversations/${g.id}/messages`,
      { body: '[年会.mp4](/uploads/9f3a.mp4)' },
      admin,
    );
    assert.equal(sent.status, 201);

    const convo = get('SELECT * FROM conversations WHERE id = ?', g.id);
    const payloads = [];
    pushForMessage(convo, sent.body.message, [zhen.id, 'u_ghost'], {
      subscriptionsFor: async () => [{
        id: 'ps_1', userId: zhen.id, deviceId: 'phone',
        endpoint: 'https://push.example.com/x', p256dh: 'p', auth: 'a',
      }],
      foregroundDevices: () => new Set(),
      send: async ({ payload }) => { payloads.push(JSON.parse(payload)); return { ok: true, status: 201 }; },
    });
    await waitFor(() => payloads.length === 1);
    assert.equal(payloads[0].title, `${sent.body.message.senderName} · 发版小组`);
    assert.equal(payloads[0].body, '[视频]');       // 不能是「[文件] 年会.mp4」
    assert.equal(payloads[0].conversationId, g.id);
  });

  it('免打扰的成员，走真的 conversation_members 也一样推不到', async () => {
    // mutedBy 这个输入是 conversations.js 从库里查的，这一条把那段 SQL 也锁住。
    const jing = await member('静音的');
    const token = await api.login(jing.email);
    const g = await group(api, admin, '免打扰群', [jing.id]);
    assert.equal((await api.patch(`/api/conversations/${g.id}/prefs`, { muted: true }, token)).status, 200);

    const sent = await api.post(`/api/conversations/${g.id}/messages`, { body: '@静音的 看一眼' }, admin);
    assert.equal(sent.status, 201);

    const convo = get('SELECT * FROM conversations WHERE id = ?', g.id);
    let asked = null;
    pushForMessage(convo, sent.body.message, [jing.id], {
      subscriptionsFor: async (ids) => { asked = ids; return []; },
      send: async () => assert.fail('免打扰的人一条都不该推'),
    });
    await new Promise((r) => setTimeout(r, 100));
    // 连订阅都不该去查——他被 mutedBy 在上一步就筛掉了。
    assert.equal(asked, null);
  });

  it('会话对象是空的（理论上不该发生）也只进日志，不往外抛', async () => {
    // pushForMessage 里除了 queuePush 还有两次同步的库操作（previewOf 和 mutedMemberIds），
    // 它们抛出来的是**同步**异常，queuePush 内部那道 try 兜不到，必须由这里的 try 兜。
    // 兜不住的话就是 res.json() 之后抛异常 → ERR_HTTP_HEADERS_SENT（issue #19）。
    assert.doesNotThrow(() => pushForMessage(null, { id: 'm_x', body: '正文', kind: 'user' }, ['u_a']));
  });
});

// ---- 真的走一遍 HTTP -----------------------------------------------------
//
// 上面几组验的是零件。这一组把 2A / 2B 那两个模块换成假的，在**真的 POST /messages**
// 上验整条线：路由 → previewOf → mutedMemberIds → 在线设备 → 扇出。
// 这段接线是本任务包最容易在合并时被顺手改掉又没人发现的地方。
describe('发消息 → 真的推出去（把 2A / 2B 换成假的）', () => {
  let sent;

  /** 装一座假桥，返回它收到的全部推送。 */
  function fakeBridge({ subscriptions = [], result = { ok: true, status: 201, gone: false } } = {}) {
    sent = [];
    const dropped = [];
    const marked = [];
    setPushBridgeForTests({
      subscriptionsFor: async (userIds) => subscriptions.filter((s) => userIds.includes(s.userId)),
      sendPush: async ({ subscription, payload }) => {
        sent.push({ subscription, payload: JSON.parse(payload) });
        return result;
      },
      deleteSubscription: async (endpoint) => dropped.push(endpoint),
      markPushResult: async (endpoint, ok) => marked.push([endpoint, ok]),
    });
    return { dropped, marked };
  }

  const subFor = (user, deviceId) => ({
    id: `ps_${user.id}_${deviceId}`,
    userId: user.id,
    deviceId,
    endpoint: `https://push.example.com/${user.id}/${deviceId}`,
    p256dh: 'p',
    auth: 'a',
  });

  after(() => setPushBridgeForTests(undefined));   // 别把假桥漏给别的用例

  it('群里发一条 → 收件人的两台设备都收到推送，标题带群名、正文是摘要', async () => {
    const shou = await member('端到端收件人');
    const g = await group(api, admin, '端到端小组', [shou.id]);
    fakeBridge({ subscriptions: [subFor(shou, 'phone'), subFor(shou, 'ipad')] });

    const res = await api.post(`/api/conversations/${g.id}/messages`, { body: '明早十点评审' }, admin);
    assert.equal(res.status, 201);
    await waitFor(() => sent.length === 2);

    assert.deepEqual(sent.map((s) => s.subscription.deviceId).sort(), ['ipad', 'phone']);
    assert.equal(sent[0].payload.title, `${res.body.message.senderName} · 端到端小组`);
    assert.equal(sent[0].payload.body, '明早十点评审');
    assert.equal(sent[0].payload.conversationId, g.id);
    assert.equal(sent[0].payload.tag, `loop-im:${g.id}`);
  });

  it('收件人的一台设备报了前台 → 只推另一台（2C 存在的全部理由）', async () => {
    const zai = await member('一台在前台');
    const token = await api.login(zai.email);
    const g = await group(api, admin, '前台判定组', [zai.id]);
    fakeBridge({ subscriptions: [subFor(zai, 'laptop'), subFor(zai, 'phone')] });

    const laptop = await openForeground(token, 'laptop');
    try {
      await waitFor(() => foregroundDeviceIds(zai.id).has('laptop'));
      assert.equal((await api.post(`/api/conversations/${g.id}/messages`, { body: '在不在' }, admin)).status, 201);
      await waitFor(() => sent.length === 1);
      await new Promise((r) => setTimeout(r, 100));   // 万一多推了，给它冒出来的时间
      assert.deepEqual(sent.map((s) => s.subscription.deviceId), ['phone']);
    } finally {
      laptop.close();
    }
  });

  it('自己发的消息不会推回自己那台设备', async () => {
    const zi = await member('自己发的');
    const token = await api.login(zi.email);
    const g = await group(api, admin, '自己发的组', [zi.id]);
    fakeBridge({ subscriptions: [subFor(zi, 'phone')] });

    assert.equal((await api.post(`/api/conversations/${g.id}/messages`, { body: '我说的' }, token)).status, 201);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(sent, []);
  });

  it('系统消息（改群名）一条推送都不发', async () => {
    const xi = await member('系统消息组员');
    const g = await group(api, admin, '老名字', [xi.id]);
    fakeBridge({ subscriptions: [subFor(xi, 'phone')] });

    assert.equal((await api.patch(`/api/conversations/${g.id}`, { title: '新名字' }, admin)).status, 200);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(sent, []);
  });

  it('免打扰的人收不到；@他 也照样收不到', async () => {
    // ⚠️ 用户拍板：「跟谁 @ 谁没关系，只要设置了免打扰就不推送」。@ 不穿透免打扰。
    const jing = await member('端到端静音');
    const ting = await member('端到端正常');
    const token = await api.login(jing.email);
    const g = await group(api, admin, '静音判定组', [jing.id, ting.id]);
    assert.equal((await api.patch(`/api/conversations/${g.id}/prefs`, { muted: true }, token)).status, 200);
    fakeBridge({ subscriptions: [subFor(jing, 'phone'), subFor(ting, 'phone')] });

    const res = await api.post(`/api/conversations/${g.id}/messages`, { body: `@${jing.name} 看一眼` }, admin);
    assert.equal(res.status, 201);
    // 真的 @ 到他了，这条用例才有意义——否则它验的只是「没 @ 也没推」。
    assert.ok(res.body.message.mentions.includes(jing.id), '这条消息压根没 @ 到他，用例白测了');

    await waitFor(() => sent.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(sent.map((s) => s.subscription.userId), [ting.id]);
  });

  it('发个视频 → 推送正文是 [视频]，不是 [文件] 年会.mp4', async () => {
    const pian = await member('看片的');
    const g = await group(api, admin, '片场', [pian.id]);
    fakeBridge({ subscriptions: [subFor(pian, 'phone')] });

    assert.equal(
      (await api.post(`/api/conversations/${g.id}/messages`, { body: '[年会.mp4](/uploads/9f3a.mp4)' }, admin)).status,
      201,
    );
    await waitFor(() => sent.length === 1);
    assert.equal(sent[0].payload.body, '[视频]');
  });

  it('推送返回 410 → 这条订阅当场删掉', async () => {
    const guo = await member('过期订阅');
    const g = await group(api, admin, '过期组', [guo.id]);
    const { dropped } = fakeBridge({
      subscriptions: [subFor(guo, 'phone')],
      result: { ok: false, status: 410, gone: true },
    });

    assert.equal((await api.post(`/api/conversations/${g.id}/messages`, { body: '还在吗' }, admin)).status, 201);
    await waitFor(() => dropped.length === 1);
    assert.deepEqual(dropped, [`https://push.example.com/${guo.id}/phone`]);
  });
});
