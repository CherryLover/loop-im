// 「该不该推」的判定规则，逐条锁住。
//
// 这些规则是**服务端和前端共用的一套语义**（见 push-decide.js 顶部那张对照表）。
// 每一条都配了一个反向用例：只有正向断言的话，把整个函数改成 `return subscriptions`
// 也能全绿。
import './helpers.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PUSH_FANOUT_CONCURRENCY,
  pushPayloadFor,
  pushTitle,
  queuePush,
  targetsFor,
} from '../src/push-decide.js';
import { PUSH_PREVIEW_LIMIT, previewOf } from '../src/routes/conversations.js';

// ---- 造数据 -------------------------------------------------------------

const msg = (over = {}) => ({
  id: 'm_1',
  conversationId: 'c_1',
  senderId: 'u_send',
  senderName: '张三',
  kind: 'user',
  body: '晚上七点开会',
  mentions: [],
  ...over,
});

/** 一条订阅。deviceId 默认跟着 userId 走，一人一台设备的常见情形。 */
const sub = (userId, deviceId = `${userId}-dev`) => ({
  id: `ps_${userId}_${deviceId}`,
  userId,
  deviceId,
  endpoint: `https://push.example.com/${userId}/${deviceId}`,
  p256dh: 'p',
  auth: 'a',
});

const endpoints = (list) => list.map((s) => s.endpoint);

describe('推送判定 · 六条规则各自', () => {
  it('规则 1 正向：收件人有订阅就推', () => {
    const out = targetsFor({
      message: msg(),
      memberIds: ['u_send', 'u_a'],
      subscriptions: [sub('u_a')],
    });
    assert.deepEqual(endpoints(out), ['https://push.example.com/u_a/u_a-dev']);
  });

  it('规则 1 反向：一条订阅都没有的人，推不到他头上', () => {
    // 「有订阅」等价于前端的 enabled——用户没在任何设备上拨开关，就一条都不该发。
    const out = targetsFor({
      message: msg(),
      memberIds: ['u_send', 'u_a', 'u_nosub'],
      subscriptions: [sub('u_a')],
    });
    assert.deepEqual(out.map((s) => s.userId), ['u_a']);
  });

  it('规则 2 反向：自己发的消息不推给自己', () => {
    const out = targetsFor({
      message: msg({ senderId: 'u_a' }),
      memberIds: ['u_a', 'u_b'],
      subscriptions: [sub('u_a'), sub('u_b')],
    });
    assert.deepEqual(out.map((s) => s.userId), ['u_b']);
  });

  it('规则 2 正向：换个人发同一条，原来那个人就收得到了', () => {
    const out = targetsFor({
      message: msg({ senderId: 'u_b' }),
      memberIds: ['u_a', 'u_b'],
      subscriptions: [sub('u_a'), sub('u_b')],
    });
    assert.deepEqual(out.map((s) => s.userId), ['u_a']);
  });

  it('规则 3 反向：系统消息（入群 / 改群名）一个都不推', () => {
    const out = targetsFor({
      message: msg({ kind: 'system', senderId: 'u_send' }),
      memberIds: ['u_send', 'u_a', 'u_b'],
      subscriptions: [sub('u_a'), sub('u_b')],
    });
    assert.deepEqual(out, []);
  });

  it('规则 3 正向：同样的收件人，kind 是 user 就照推', () => {
    const out = targetsFor({
      message: msg({ kind: 'user' }),
      memberIds: ['u_send', 'u_a', 'u_b'],
      subscriptions: [sub('u_a'), sub('u_b')],
    });
    assert.equal(out.length, 2);
  });

  it('规则 4 反向：设了免打扰就不推', () => {
    const out = targetsFor({
      message: msg(),
      memberIds: ['u_send', 'u_a', 'u_b'],
      mutedBy: new Set(['u_a']),
      subscriptions: [sub('u_a'), sub('u_b')],
    });
    assert.deepEqual(out.map((s) => s.userId), ['u_b']);
  });

  it('规则 4 · @我 且 免打扰 → 照样不推', () => {
    // ⚠️ 这一条是用户明确拍板的语义，也是最容易被后人「优化」掉的一条。
    // 用户原话：「跟谁 @ 谁没关系，只要设置了免打扰就不推送」。
    // 方案文档 §E.1 Q1 讨论过「@我 穿透免打扰」这个很多 IM 都有的做法，**已被否决**：
    // 免打扰一票否决，服务端和前端 shouldNotifyMessage 一套规则、没有例外。
    // 谁要改这一条，先去改需求，别从这里开口子。
    const out = targetsFor({
      message: msg({ mentions: ['u_a'] }),
      memberIds: ['u_send', 'u_a'],
      mutedBy: new Set(['u_a']),
      subscriptions: [sub('u_a')],
    });
    assert.deepEqual(out, []);
  });

  it('规则 4 · @全员 也穿不透免打扰', () => {
    const out = targetsFor({
      message: msg({ mentions: ['all'] }),
      memberIds: ['u_send', 'u_a', 'u_b'],
      mutedBy: new Set(['u_a']),
      subscriptions: [sub('u_a'), sub('u_b')],
    });
    assert.deepEqual(out.map((s) => s.userId), ['u_b']);
  });

  it('规则 5 反向：这台设备报告了自己在前台，就不推它', () => {
    const out = targetsFor({
      message: msg(),
      memberIds: ['u_send', 'u_a'],
      subscriptions: [sub('u_a', 'phone')],
      foregroundDevices: { u_a: ['phone'] },
    });
    assert.deepEqual(out, []);
  });

  it('规则 5 正向：报前台的是别人的设备，不影响我这台', () => {
    const out = targetsFor({
      message: msg(),
      memberIds: ['u_send', 'u_a', 'u_b'],
      subscriptions: [sub('u_a', 'phone'), sub('u_b', 'phone')],
      // 同一个 deviceId 字符串，但挂在别人名下——按人 + 设备两维一起判，不能只看设备。
      foregroundDevices: { u_b: ['phone'] },
    });
    assert.deepEqual(out.map((s) => s.userId), ['u_a']);
  });

  it('规则 5 兜底：订阅没有 deviceId 时对不上任何一台设备，按「宁可多推」照推', () => {
    const out = targetsFor({
      message: msg(),
      memberIds: ['u_send', 'u_a'],
      subscriptions: [{ ...sub('u_a'), deviceId: null }],
      foregroundDevices: { u_a: ['phone', 'laptop'] },
    });
    assert.equal(out.length, 1);
  });

  it('兜底：不是会话成员的订阅一律丢掉', () => {
    // 调用方本来就只查成员的订阅，这一道是纯粹的第二道防线——
    // 推送带着消息摘要，宁可漏发也不能发错人。
    const out = targetsFor({
      message: msg(),
      memberIds: ['u_send', 'u_a'],
      subscriptions: [sub('u_a'), sub('u_outsider')],
    });
    assert.deepEqual(out.map((s) => s.userId), ['u_a']);
  });

  it('兜底：endpoint 是空的订阅推不出去，早点丢掉', () => {
    const out = targetsFor({
      message: msg(),
      memberIds: ['u_send', 'u_a'],
      subscriptions: [{ ...sub('u_a'), endpoint: '' }],
    });
    assert.deepEqual(out, []);
  });
});

describe('推送判定 · 按设备判而不是按人判', () => {
  it('同一个人两台设备，一台报了前台一台没报 → 只推没报的那台', () => {
    // 这是整个 2C 存在的理由（§C.3）：桌面挂着网页 + 手机 PWA 关着，
    // 按人判会判成「他在线」→ 一条都不发 → 手机永远静默，
    // 而「人不在电脑前」正是最需要手机响的时候。
    const out = targetsFor({
      message: msg(),
      memberIds: ['u_send', 'u_a'],
      subscriptions: [sub('u_a', 'laptop'), sub('u_a', 'phone')],
      foregroundDevices: { u_a: ['laptop'] },
    });
    assert.deepEqual(out.map((s) => s.deviceId), ['phone']);
  });

  it('三台设备两台报了前台 → 只推剩下那台', () => {
    const out = targetsFor({
      message: msg(),
      memberIds: ['u_send', 'u_a'],
      subscriptions: [sub('u_a', 'laptop'), sub('u_a', 'phone'), sub('u_a', 'ipad')],
      foregroundDevices: { u_a: ['laptop', 'ipad'] },
    });
    assert.deepEqual(out.map((s) => s.deviceId), ['phone']);
  });

  it('三台设备全报了前台 → 一条都不推', () => {
    const out = targetsFor({
      message: msg(),
      memberIds: ['u_send', 'u_a'],
      subscriptions: [sub('u_a', 'laptop'), sub('u_a', 'phone'), sub('u_a', 'ipad')],
      foregroundDevices: { u_a: ['laptop', 'phone', 'ipad'] },
    });
    assert.deepEqual(out, []);
  });

  it('同一台 iPhone：Safari 标签开着 + 主屏 App 关着 → 照推主屏那个', () => {
    // iOS 的存储沙箱让标签页和主屏 App 各有各的 deviceId（§C.3），
    // 系统把它们当成两台设备——这正确：Safari 开着时主屏 App 确实是关着的。
    const out = targetsFor({
      message: msg(),
      memberIds: ['u_send', 'u_a'],
      subscriptions: [sub('u_a', 'safari-tab'), sub('u_a', 'home-screen')],
      foregroundDevices: { u_a: ['safari-tab'] },
    });
    assert.deepEqual(out.map((s) => s.deviceId), ['home-screen']);
  });

  it('五个人的群、三个人报了前台 → 只推另外两个', () => {
    const out = targetsFor({
      message: msg({ senderId: 'u_1' }),
      memberIds: ['u_1', 'u_2', 'u_3', 'u_4', 'u_5'],
      subscriptions: ['u_2', 'u_3', 'u_4', 'u_5'].map((u) => sub(u, 'only')),
      foregroundDevices: { u_2: ['only'], u_3: ['only'] },
    });
    assert.deepEqual(out.map((s) => s.userId), ['u_4', 'u_5']);
  });
});

describe('推送判定 · 规则组合', () => {
  it('六条一起上：只剩「有订阅、不是自己、非系统消息、没免打扰、那台设备没报前台」的', () => {
    const out = targetsFor({
      message: msg({ senderId: 'u_send' }),
      memberIds: ['u_send', 'u_muted', 'u_online', 'u_multi', 'u_nosub'],
      mutedBy: new Set(['u_muted']),
      subscriptions: [
        sub('u_send', 'own-phone'),      // 规则 2：自己发的
        sub('u_muted', 'm-phone'),       // 规则 4：免打扰
        sub('u_online', 'o-laptop'),     // 规则 5：这台报了前台
        sub('u_multi', 'x-laptop'),      // 规则 5：这台报了前台
        sub('u_multi', 'x-phone'),       // ✅ 唯一该推的
        sub('u_outsider', 'out'),        // 不是成员
      ],
      foregroundDevices: { u_online: ['o-laptop'], u_multi: ['x-laptop'], u_send: ['own-phone'] },
    });
    assert.deepEqual(endpoints(out), ['https://push.example.com/u_multi/x-phone']);
  });

  it('系统消息压过一切：哪怕所有人都离线、都没免打扰，也一条不推', () => {
    const out = targetsFor({
      message: msg({ kind: 'system' }),
      memberIds: ['u_send', 'u_a', 'u_b', 'u_c'],
      subscriptions: [sub('u_a'), sub('u_b'), sub('u_c')],
    });
    assert.deepEqual(out, []);
  });
});

describe('推送判定 · Aria（AI）不做特例', () => {
  const aria = (over = {}) => msg({ senderId: 'ai', senderName: 'Aria', ...over });

  it('Aria 的回复推给群里所有没设免打扰的人，不只是触发她的那个人', () => {
    // ⚠️ 方案文档 §E.1 Q3 倾向「只推给触发她的那个人」，**已被用户否决**：要的是规则统一。
    // 这个模块里出现任何 AI_ID / senderName === 'Aria' 的分支，就是有人在加特例。
    const out = targetsFor({
      message: aria(),
      memberIds: ['ai', 'u_asker', 'u_bystander_1', 'u_bystander_2'],
      subscriptions: [sub('u_asker'), sub('u_bystander_1'), sub('u_bystander_2')],
    });
    assert.deepEqual(out.map((s) => s.userId), ['u_asker', 'u_bystander_1', 'u_bystander_2']);
  });

  it('Aria 的回复同样过免打扰这一关', () => {
    const out = targetsFor({
      message: aria(),
      memberIds: ['ai', 'u_asker', 'u_bystander'],
      mutedBy: new Set(['u_bystander']),
      subscriptions: [sub('u_asker'), sub('u_bystander')],
    });
    assert.deepEqual(out.map((s) => s.userId), ['u_asker']);
  });

  it('Aria 的回复同样按设备判前台', () => {
    const out = targetsFor({
      message: aria(),
      memberIds: ['ai', 'u_asker'],
      subscriptions: [sub('u_asker', 'laptop'), sub('u_asker', 'phone')],
      foregroundDevices: { u_asker: ['laptop'] },
    });
    assert.deepEqual(out.map((s) => s.deviceId), ['phone']);
  });

  it('Aria 自己有订阅也不会收到自己的回复（规则 2 一视同仁）', () => {
    const out = targetsFor({
      message: aria(),
      memberIds: ['ai', 'u_asker'],
      subscriptions: [sub('ai'), sub('u_asker')],
    });
    assert.deepEqual(out.map((s) => s.userId), ['u_asker']);
  });
});

// ⚠️ 这一组是真机反馈改过的：标题里**不带应用名**。
//
// 带的时候 iPhone 上显示成：
//     Loop IM · 测试人员
//     from Loop                ← iOS 自动附上的 manifest short_name，去不掉
// 应用名一条通知里出现两遍，还把最该抢眼的发送者挤到了后面。
//
// 谁想把 `Loop IM · ` 加回来，先去真机上看一眼那行 from Loop。
describe('推送标题 · 不带应用名（iOS 自己会附一行）', () => {
  it('单聊：标题就是发送者本人，一个字都不多', () => {
    assert.equal(pushTitle(msg(), { type: 'dm' }), '张三');
  });

  it('群聊：发送者 · 群名，缺了群名就不知道消息从哪个群冒出来', () => {
    assert.equal(pushTitle(msg(), { type: 'group', title: '发版小组' }), '张三 · 发版小组');
  });

  it('AI 会话按单聊排：标题就是 Aria 本人', () => {
    assert.equal(pushTitle(msg({ senderName: 'Aria' }), { type: 'ai' }), 'Aria');
  });

  it('群没有标题时退回一段，不留一个空荡荡的「· 」尾巴', () => {
    assert.equal(pushTitle(msg(), { type: 'group', title: null }), '张三');
  });

  it('会话对象没传（理论上不该发生）也不能崩', () => {
    assert.equal(pushTitle(msg(), undefined), '张三');
  });

  it('发送者名字也没有时退回「新消息」，而不是空标题', () => {
    assert.equal(pushTitle(msg({ senderName: '' }), { type: 'dm' }), '新消息');
  });

  it('标题里不出现应用名 —— 单聊、群聊、AI 三种都查一遍', () => {
    // 上面四条是逐字断言，这一条是**兜底**：换个分隔符、换个拼法都逃不掉。
    // 单看逐字断言的话，有人把它们连同实现一起改回带应用名的版本仍然会全绿。
    for (const conversation of [{ type: 'dm' }, { type: 'group', title: '发版小组' }, { type: 'ai' }]) {
      const title = pushTitle(msg(), conversation);
      assert.doesNotMatch(title, /Loop/i, `标题里混进了应用名：${title}`);
    }
  });

  it('和前端 notifyTitle 是同一个形状：`发送者` / `发送者 · 群名`', () => {
    // web/src/lib/notify.ts 的 notifyTitle 就是这两句。两边长得不一样的话，
    // 同一条消息在桌面本地通知和手机推送上会是两个标题（§C.5 明确要求一致）。
    const notifyTitle = (m, c) => (c?.type === 'group' && c.title ? `${m.senderName} · ${c.title}` : m.senderName);
    for (const conversation of [{ type: 'dm' }, { type: 'group', title: '发版小组' }, { type: 'ai' }]) {
      assert.equal(pushTitle(msg(), conversation), notifyTitle(msg(), conversation));
    }
  });
});

describe('推送 payload', () => {
  it('tag 和前端桌面通知同一个口径，同一个会话的通知会互相覆盖而不是堆一摞', () => {
    const payload = pushPayloadFor({ message: msg(), conversation: { type: 'dm' }, body: '晚上七点开会' });
    assert.deepEqual(payload, {
      title: '张三',
      body: '晚上七点开会',
      tag: 'loop-im:c_1',
      conversationId: 'c_1',
    });
  });
});

describe('推送正文摘要 · 与会话列表最后一条消息同一个函数', () => {
  it('图片：![](…) → [图片]', () => {
    assert.equal(previewOf('![发版流程](/uploads/9f3a.png)'), '[图片]');
  });

  it('视频：/uploads 下的 .mp4 → [视频]，不能是 [文件]', () => {
    const out = previewOf('[年会.mp4](/uploads/9f3a.mp4)');
    assert.equal(out, '[视频]');
    assert.doesNotMatch(out, /\[文件\]/);
  });

  it('视频：.webm 同样是 [视频]', () => {
    assert.equal(previewOf('[片子.webm](/uploads/9f3a.webm)'), '[视频]');
  });

  it('视频：写成图片语法的 .mp4 也是 [视频]', () => {
    // 判据是服务端给的扩展名，不是发消息的人当初打了哪种语法——口径同 web/src/lib/md.ts。
    assert.equal(previewOf('![年会](/uploads/9f3a.mp4)'), '[视频]');
  });

  it('视频：大小写不敏感', () => {
    assert.equal(previewOf('[X](/uploads/9f3a.MP4)'), '[视频]');
  });

  it('文件：非视频的站内附件仍是「[文件] 名字」，一个字都没变', () => {
    assert.equal(previewOf('[发版清单.pdf](/uploads/9f3a.pdf)'), '[文件] 发版清单.pdf');
  });

  it('文件：路径里带 ?v=.mp4 的 .bin 不算视频（后缀在查询串里，不作数）', () => {
    // 正文是用户手打的，`[x](/uploads/a.bin?v=.mp4)` 不能因此被叫成视频。
    // 这一条和前端 md.ts 先切 ?query 再看后缀是同一个理由。
    assert.equal(previewOf('[怪东西](/uploads/9f3a.bin?v=.mp4)'), '[文件] 怪东西');
  });

  it('外站链接指向 .mp4 不算站内视频', () => {
    // 给足字数，免得断言实际验的是 26 字截断而不是视频判定。
    assert.equal(
      previewOf('[外链](https://example.com/a.mp4)', PUSH_PREVIEW_LIMIT),
      '[外链](https://example.com/a.mp4)',
    );
  });

  it('图文混排：一句话 + 一个视频，两样都留下', () => {
    assert.equal(previewOf('看这个 [年会.mp4](/uploads/9f3a.mp4) 好笑'), '看这个 [视频] 好笑');
  });

  it('推送这一档给到 120 字，比会话列表那 26 字长得多', () => {
    const long = '一'.repeat(200);
    assert.equal(previewOf(long).length, 26);
    assert.equal(previewOf(long, PUSH_PREVIEW_LIMIT).length, 120);
  });

  it('120 字这一档同样按字素簇切，不会把 emoji 切成半个', () => {
    const body = `${'一'.repeat(119)}👨‍👩‍👧`;
    const out = previewOf(body, PUSH_PREVIEW_LIMIT);
    // 不能用 out.at(-1)：那按 UTF-16 码元取，一家三口的最后一个码元是半个代理对。
    assert.ok(out.endsWith('👨‍👩‍👧'), `末尾被切坏了：${JSON.stringify(out.slice(-8))}`);
    assert.doesNotMatch(out, /�/);
  });
});

describe('queuePush · 扇出与隔离', () => {
  /** 一次「什么都成功」的推送所需的全套注入。 */
  const wiring = (over = {}) => ({
    subscriptionsFor: async () => [sub('u_a', 'phone')],
    send: async () => ({ ok: true, status: 201, gone: false }),
    foregroundDevices: () => new Set(),
    ...over,
  });

  const ctx = (over = {}) => ({
    message: msg(),
    conversation: { type: 'group', title: '发版小组' },
    body: '晚上七点开会',
    memberIds: ['u_send', 'u_a'],
    mutedBy: new Set(),
    ...over,
  });

  it('把 payload 发给该发的那台设备', async () => {
    const sent = [];
    await queuePush(ctx(), wiring({ send: async (args) => { sent.push(args); return { ok: true, status: 201 }; } }));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subscription.deviceId, 'phone');
    assert.deepEqual(JSON.parse(sent[0].payload), {
      title: '张三 · 发版小组',
      body: '晚上七点开会',
      tag: 'loop-im:c_1',
      conversationId: 'c_1',
    });
  });

  it('系统消息连订阅都不查', async () => {
    let queried = 0;
    await queuePush(ctx({ message: msg({ kind: 'system' }) }), wiring({
      subscriptionsFor: async () => { queried += 1; return []; },
    }));
    assert.equal(queried, 0);
  });

  it('免打扰的人和发送者自己，连订阅都不查', async () => {
    let asked = null;
    await queuePush(
      ctx({ memberIds: ['u_send', 'u_a', 'u_muted'], mutedBy: new Set(['u_muted']) }),
      wiring({ subscriptionsFor: async (ids) => { asked = ids; return []; } }),
    );
    assert.deepEqual(asked, ['u_a']);
  });

  it('全场都报了前台时一条请求都不发', async () => {
    let sends = 0;
    await queuePush(ctx(), wiring({
      foregroundDevices: () => new Set(['phone']),
      send: async () => { sends += 1; return { ok: true, status: 201 }; },
    }));
    assert.equal(sends, 0);
  });

  it('并发有上限：50 人的群不会一次全放出去', async () => {
    const many = Array.from({ length: 50 }, (_, i) => sub(`u_${i}`, 'only'));
    let inflight = 0;
    let peak = 0;
    await queuePush(
      ctx({ memberIds: ['u_send', ...many.map((s) => s.userId)] }),
      wiring({
        subscriptionsFor: async () => many,
        send: async () => {
          inflight += 1;
          peak = Math.max(peak, inflight);
          await new Promise((r) => setTimeout(r, 1));
          inflight -= 1;
          return { ok: true, status: 201 };
        },
      }),
    );
    assert.equal(peak, PUSH_FANOUT_CONCURRENCY);
    assert.ok(peak < 50, `并发被放到了 ${peak}，等于没有限流`);
  });

  it('50 个目标一个不落，全都发到了', async () => {
    const many = Array.from({ length: 50 }, (_, i) => sub(`u_${i}`, 'only'));
    const seen = new Set();
    await queuePush(
      ctx({ memberIds: ['u_send', ...many.map((s) => s.userId)] }),
      wiring({
        subscriptionsFor: async () => many,
        send: async ({ subscription }) => { seen.add(subscription.endpoint); return { ok: true, status: 201 }; },
      }),
    );
    assert.equal(seen.size, 50);
  });

  it('404 / 410：endpoint 被回收了，立刻删掉这条订阅', async () => {
    const dropped = [];
    await queuePush(ctx(), wiring({
      send: async () => ({ ok: false, status: 410, gone: true }),
      forget: async (endpoint) => dropped.push(endpoint),
      mark: async () => assert.fail('gone 的订阅不该再去记成败'),
    }));
    assert.deepEqual(dropped, ['https://push.example.com/u_a/phone']);
  });

  it('没 gone 的按成败记一笔，供运维排查（不参与判定）', async () => {
    const marks = [];
    await queuePush(ctx(), wiring({
      send: async () => ({ ok: false, status: 500, gone: false }),
      mark: async (endpoint, ok) => marks.push([endpoint, ok]),
      forget: async () => assert.fail('500 不是永久失败，不许删订阅'),
    }));
    assert.deepEqual(marks, [['https://push.example.com/u_a/phone', false]]);
  });

  it('一台设备推失败不连累同一批里排在它后面的设备', async () => {
    // concurrency 必须压到 1：并发跑的话「炸的那台」和「好的那台」是同时出发的，
    // 就算异常没被吞掉，后面那台也早就发出去了——用例会假绿。
    // 压到 1、把会炸的排在前面，才真的在验「异常被就地吞住、循环继续往下走」。
    const ok = [];
    await queuePush(
      ctx({ memberIds: ['u_send', 'u_a', 'u_b'] }),
      wiring({
        concurrency: 1,
        subscriptionsFor: async () => [sub('u_a', 'boom'), sub('u_b', 'fine')],
        send: async ({ subscription }) => {
          if (subscription.deviceId === 'boom') throw new Error('苹果的服务器抽风了');
          ok.push(subscription.deviceId);
          return { ok: true, status: 201 };
        },
        onError: () => {},
      }),
    );
    assert.deepEqual(ok, ['fine']);
  });

  it('推送整条链路炸了也只 resolve，绝不往外抛', async () => {
    // 这是 issue #19 那个坑：调用点在 res.json() 之后，抛出去会被 Express 5 转给
    // 错误中间件，那时 headersSent 已是 true，撞 ERR_HTTP_HEADERS_SENT，
    // 在日志里留下一串跟真实故障无关的堆栈。
    const errs = [];
    await queuePush(ctx(), wiring({
      subscriptionsFor: async () => { throw new Error('订阅表查不动了'); },
      onError: (err) => errs.push(err.message),
    }));
    assert.deepEqual(errs, ['订阅表查不动了']);
  });

  it('subscriptionsFor 返回 null 也不能崩', async () => {
    const errs = [];
    await queuePush(ctx(), wiring({ subscriptionsFor: async () => null, onError: (e) => errs.push(e) }));
    assert.deepEqual(errs, []);
  });

  it('推送模块还没接上时静默跳过，不报错也不重试到刷屏', async () => {
    // 本分支上 web-push.js / push-store.js 还不存在（2A / 2B 是并行的另外两个包）。
    // 这一条锁住的是：缺了它们，发消息这条链路必须一点感觉都没有。
    const errs = [];
    await queuePush(ctx(), { onError: (err) => errs.push(err) });
    assert.deepEqual(errs, []);
  });
});
