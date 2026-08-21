// emoji 全链路不被切坏。
//
// 起因是一个实测出来的 bug：所有摘要都用 String.prototype.slice() 截断，它按 UTF-16
// **码元**切，正好切在 emoji 中间就把代理对劈成两半，界面上是一个 �：
//
//   '一二三四五六七八九十一二三四五六七八九十一二三四五👍收到'.slice(0, 26)
//     -> '一二三四五六七八九十一二三四五六七八九十一二三四五\ud83d'
//
// 光改成按码点切只解决一半：变体选择符、肤色修饰符、ZWJ 家庭、国旗照样会碎。
// 正确的粒度是**字素簇**（见 src/text.js）。这一组用例就是拿真实 emoji 把这件事钉住。
//
// 前端有同名的一组（web/src/lib/text.test.ts），样本和期望值必须与这里逐条对齐 ——
// 两端各有一份实现，只能靠测试保证它们不漂。
import { startServer } from './helpers.js';
import { direct, member } from './fixtures.js';
import { graphemeLength, graphemes, truncate } from '../src/text.js';
import { REACTION_EMOJIS, canonicalEmojiKey, normalizeEmoji } from '../src/reactions.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/** 有没有落单的代理项 —— 也就是「被切坏了」的判据，肉眼上就是那个 �。 */
const hasLoneSurrogate = (s) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

/** 真实样本。这几类的碎法各不相同，缺一类就会漏掉一种碎法。 */
const SAMPLES = [
  ['基本 emoji', '👍', 2],
  // ❤ 是 BMP 里的字符（一个码元），加上变体选择符才是两个 —— 它不产生孤儿代理项，
  // 但按码元/码点切一样会把 FE0F 丢掉，红心变成黑心，同样属于「切坏了」。
  ['变体选择符', '❤️', 2],
  ['肤色修饰符', '👍🏽', 4],
  ['ZWJ 家庭', '👨‍👩‍👧', 8],
  ['国旗（两个区域指示符）', '🇨🇳', 4],
];

describe('按字素簇截断', () => {
  it('每个样本都是一个字素簇，但码元数各不相同', () => {
    for (const [name, emoji, units] of SAMPLES) {
      assert.equal(emoji.length, units, `${name} 的码元数变了，样本可能被编辑器改坏了`);
      assert.equal(graphemeLength(emoji), 1, `${name} 应该算一个「字」`);
      assert.deepEqual(graphemes(emoji), [emoji], `${name} 不该被拆开`);
    }
  });

  it('emoji 正好压在截断边界上时，整颗保留或整颗丢掉，绝不留半个', () => {
    for (const [name, emoji] of SAMPLES) {
      const head = '一二三四五六七八九十一二三四五六七八九十一二三四五';   // 25 个字
      const body = `${head}${emoji}收到`;

      // 先证明 bug 确实存在：码元切法在这里就是坏的（❤️ 不产生孤儿代理项，
      // 但会把变体选择符切掉，红心变黑心，同样是坏的）。
      const sliced = body.slice(0, 26);
      assert.notEqual(sliced, `${head}${emoji}`, `${name}：slice 竟然切对了？样本失效了`);

      // limit=26 时 emoji 是第 26 个字，应当完整留下。
      assert.equal(truncate(body, 26), `${head}${emoji}`, `${name}：第 26 个字应完整保留`);
      // limit=25 时 emoji 落在边界外，应当整颗丢掉，而不是留半个。
      assert.equal(truncate(body, 25), head, `${name}：越界的 emoji 应整颗丢掉`);

      for (let n = 1; n <= graphemeLength(body); n += 1) {
        const out = truncate(body, n);
        assert.ok(!hasLoneSurrogate(out), `${name}：limit=${n} 切出了孤儿代理项 ${JSON.stringify(out)}`);
        assert.equal(graphemeLength(out), Math.min(n, graphemeLength(body)), `${name}：limit=${n} 字数不对`);
        assert.ok(body.startsWith(out), `${name}：limit=${n} 的结果必须是原文的前缀`);
      }
    }
  });

  it('ZWJ 家庭切在任何位置都不会剩下悬空的连接符或半个家庭', () => {
    const body = `${'啊'.repeat(5)}👨‍👩‍👧好`;
    for (let n = 1; n <= 7; n += 1) {
      const out = truncate(body, n);
      assert.ok(!out.endsWith('‍'), `limit=${n} 结尾留了悬空 ZWJ：${JSON.stringify(out)}`);
      assert.ok(!hasLoneSurrogate(out), `limit=${n} 切出了孤儿代理项`);
    }
    assert.equal(truncate(body, 5), '啊啊啊啊啊', '第 6 个字是一家三口，limit=5 时整颗不要');
    assert.equal(truncate(body, 6), '啊啊啊啊啊👨‍👩‍👧', 'limit=6 时一家三口要完整');
  });

  it('国旗是两个区域指示符，不能只留一个', () => {
    assert.equal(truncate('🇨🇳🇯🇵', 1), '🇨🇳');
    assert.equal(truncate('🇨🇳🇯🇵', 2), '🇨🇳🇯🇵');
    assert.equal(graphemeLength('🇨🇳🇯🇵'), 2, '两面旗是两个字，不是四个');
  });

  it('纯 emoji 串按「用户眼里的字数」给够，不因为码元多而少给', () => {
    const flags = '🇨🇳'.repeat(10);
    assert.equal(graphemeLength(flags), 10);
    assert.equal(truncate(flags, 10), flags, '10 面旗只有 10 个字，不该被截');
    assert.equal(flags.slice(0, 10).length, 10, 'slice 只能给到 2.5 面旗——这正是要修的');
  });

  it('短于上限时原样返回，边界参数不炸', () => {
    assert.equal(truncate('你好👍', 99), '你好👍');
    assert.equal(truncate('你好👍', 0), '');
    assert.equal(truncate('你好👍', -1), '');
    assert.equal(truncate('你好👍', NaN), '');
    assert.equal(truncate('', 10), '');
    assert.equal(truncate(null, 10), '');
    assert.equal(truncate(undefined, 10), '');
    assert.equal(graphemeLength(''), 0);
    assert.equal(graphemeLength(null), 0);
  });
});

describe('表情回应的归一', () => {
  it('变体选择符可有可无，两种写法归到白名单里那一种', () => {
    assert.equal(normalizeEmoji('❤️'), '❤️', '带 U+FE0F 的写法');
    assert.equal(normalizeEmoji('❤'), '❤️', '不带 U+FE0F 的写法要归一到带的那份');
    assert.equal(normalizeEmoji('❤︎'), '❤️', 'U+FE0E（文字呈现）也是纯表现，一并抹掉');
    assert.equal(normalizeEmoji('👍️'), '👍', '白名单里不带 FE0F 的，带了也认');
  });

  it('悬空的 ZWJ 是截断残留，归一时抹掉', () => {
    assert.equal(normalizeEmoji('👍‍'), '👍', '结尾的连接符没有右操作数');
    assert.equal(normalizeEmoji('‍👍'), '👍', '开头的连接符没有左操作数');
    assert.equal(normalizeEmoji('‍👍‍'), '👍', '两头都有也一样');
    assert.equal(normalizeEmoji('👍‍‍‍'), '👍', '连着好几个也一样');
    assert.equal(normalizeEmoji('❤‍️'), '❤️', 'FE0F 和悬空 ZWJ 混在一起也要归一');
  });

  it('**中间**的 ZWJ 有语义，绝不能删 —— 删了 👨‍👩‍👧 就和 👨👩👧 撞成一行', () => {
    assert.notEqual(
      canonicalEmojiKey('👨‍👩‍👧'),
      canonicalEmojiKey('👨👩👧'),
      '一家三口和三个各自独立的人必须是两个不同的 key',
    );
    // 归一只抹表现，不动结构：中间的连接符原样还在。
    assert.equal(canonicalEmojiKey('👨‍👩‍👧'), '👨‍👩‍👧');
    // 将来往白名单里加 ZWJ 表情时，内部的 FE0F 会被抹掉、两侧的 ZWJ 保留。
    assert.equal(canonicalEmojiKey('👩‍❤️‍👨'), '👩‍❤‍👨');
  });

  it('白名单之外的一律拒绝，非字符串也拒绝', () => {
    for (const bad of ['🍺', 'x', '<b>hi</b>', '👍👍', '', '👨‍👩‍👧']) {
      assert.equal(normalizeEmoji(bad), null, `${JSON.stringify(bad)} 不在白名单里，应该被拒`);
    }
    for (const bad of [null, undefined, 1, ['👍'], { emoji: '👍' }]) {
      assert.equal(normalizeEmoji(bad), null, '非字符串一律拒绝，不做 String() 转换');
    }
    assert.equal(normalizeEmoji('👍'.repeat(100)), null, '超长 payload 在做任何字符串处理前就被挡掉');
  });

  it('白名单里每一个都能原样通过（归一不该把自己人拒之门外）', () => {
    for (const emoji of REACTION_EMOJIS) {
      assert.equal(normalizeEmoji(emoji), emoji, `${emoji} 归一后应还是它自己`);
    }
  });
});

describe('emoji 走完整条链路不被切坏', () => {
  let api, chen, zhou, chenToken, zhouToken, dm;

  before(async () => {
    api = await startServer();
    const adminToken = await api.loginAdmin();
    chen = await member('陈子航', { dept: '后端' });
    zhou = await member('周明', { dept: '前端' });
    chenToken = await api.login(chen.email);
    zhouToken = await api.login(zhou.email);
    // Aria 不插话，摘要里才只有我们发的那条。
    await api.put('/api/ai/settings', { silentRead: false, replyAtAll: false, allowDm: true }, adminToken);
    dm = await direct(api, chenToken, zhou.id);
  });
  after(async () => { await api.close(); });

  it('会话列表预览（26 字）不留半个 emoji', async () => {
    for (const [name, emoji] of SAMPLES) {
      const body = `${'一二三四五六七八九十一二三四五六七八九十一二三四五'}${emoji}收到`;
      await api.post(`/api/conversations/${dm.id}/messages`, { body }, chenToken);
      const list = (await api.get('/api/conversations', zhouToken)).body.conversations;
      const preview = list.find((c) => c.id === dm.id).lastMessage.preview;
      assert.ok(!hasLoneSurrogate(preview), `${name}：预览里有孤儿代理项 ${JSON.stringify(preview)}`);
      assert.ok(preview.endsWith(emoji), `${name}：预览应当以完整的 emoji 收尾，实际 ${JSON.stringify(preview)}`);
    }
  });

  it('引用摘要（48 字）不留半个 emoji', async () => {
    const head = '一二三四五六七八九十'.repeat(4) + '一二三四五六七';   // 47 个字
    for (const [name, emoji] of SAMPLES) {
      const sent = await api.post(`/api/conversations/${dm.id}/messages`, { body: `${head}${emoji}尾巴` }, chenToken);
      const reply = await api.post(
        `/api/conversations/${dm.id}/messages`,
        { body: '收到', replyTo: sent.body.message.id },
        zhouToken,
      );
      const quote = reply.body.message.quote;
      assert.ok(!hasLoneSurrogate(quote.preview), `${name}：引用摘要里有孤儿代理项 ${JSON.stringify(quote.preview)}`);
      assert.equal(quote.preview, `${head}${emoji}`, `${name}：第 48 个字应是完整的 emoji`);
    }
  });

  it('正文原样存、原样取 —— 截断只发生在摘要里，消息本体一个字节都不能少', async () => {
    const body = `全都要：${SAMPLES.map(([, e]) => e).join('')} 一个都不许少`;
    const sent = await api.post(`/api/conversations/${dm.id}/messages`, { body }, chenToken);
    assert.equal(sent.body.message.body, body, '写回来的正文必须与发出去的完全一致');
    const fetched = (await api.get(`/api/conversations/${dm.id}/messages`, zhouToken)).body.messages;
    assert.equal(fetched.find((m) => m.id === sent.body.message.id).body, body, '读出来的正文必须一字不差');
  });

  it('emoji 关键词的长度按「字」算，不按码元算', async () => {
    // 60 个「字」，但 240 个码元 —— 按 .length 算会被误判成超过 100 而拒掉。
    const q = '🇨🇳'.repeat(60);
    assert.equal(q.length, 240, '样本失效了');
    const ok = await api.get(`/api/messages/search?q=${encodeURIComponent(q)}`, chenToken);
    assert.equal(ok.status, 200, '60 个字的关键词不该被当成超长');

    const tooLong = await api.get(`/api/messages/search?q=${encodeURIComponent('🇨🇳'.repeat(101))}`, chenToken);
    assert.equal(tooLong.status, 400, '101 个字确实超了，还是要拒');
  });

  it('搜索能搜到 emoji，结果正文完整', async () => {
    const body = `发布会定在周五 🎉🇨🇳 别迟到`;
    await api.post(`/api/conversations/${dm.id}/messages`, { body }, chenToken);
    const res = await api.get(`/api/messages/search?q=${encodeURIComponent('🎉🇨🇳')}`, zhouToken);
    assert.equal(res.status, 200);
    const hit = res.body.results.find((r) => r.body === body);
    assert.ok(hit, 'emoji 关键词应该能搜到那条消息');
  });
});
