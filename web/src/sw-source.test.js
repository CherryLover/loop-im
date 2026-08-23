// 这是一道闸门，不是普通用例。它守的是整个 PWA 改造里唯一一条不可协商的约束：
//
//   ── public/sw.js 里永远不许出现 fetch 事件监听 ──
//
// 为什么这条值得一道闸门：一旦 SW 监听了 fetch，页面的每一个请求都会先经过我们的
// 代码，缓存行为就从「浏览器默认」变成「我们写的那几行」。这个项目刚吃过一次静默
// 缓存的亏（见同目录 styles-integrity.test.js 顶部的事故说明：一个丢掉的花括号让整批
// 样式失效，九项 CI 全绿，靠人肉看出来的）。缓存出错的症状是一模一样的：不报错，
// 但用户看到的是旧界面。
//
// 没有 fetch handler，浏览器根本不把请求交给 SW，缓存行为与「没有 SW」逐字节相同。
// 风险从「靠人自觉」变成结构上不可能 —— 前提是没人顺手加上那一行。这道闸门就是防
// 「顺手」的。它防的是无意，不是恶意：真想绕开，删掉这个文件就行了，那时至少是个
// 需要在 review 里解释的显式动作。
//
// 离线可用不在本项目的目标里：这是个 IM，离线打开一个拉不到消息的空壳没有意义。
// 所以这条红线没有任何代价，纯赚。
//
// 写成 .js 而不是 .ts 是有意的，理由同 styles-integrity.test.js：tsconfig 的 include
// 只覆盖 src 且没开 allowJs，tsc 不会检查这个文件，也就不必为了一个 node:fs 的 import
// 去给 web 装 @types/node。vitest 的 include 已经收 .js。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// 不用 import.meta.url：vitest 转换后的模块里它不是 file: scheme，fileURLToPath 会抛。
// vitest 的 root 是 web/，所以按 cwd 找；带一个上层候选，免得有人从仓库根跑。
const SW_PATH = ['public/sw.js', 'web/public/sw.js']
  .map((p) => resolve(process.cwd(), p))
  .find(existsSync);

/**
 * 去掉注释，但**保留字符串字面量**。
 *
 * 两件事都是必须的：
 * - 去注释：sw.js 顶部那段红线注释本身就反复出现 'fetch' 这个词，不去掉的话闸门
 *   会被自己的说明文档误伤，那它一天都活不下去。
 * - 保留字符串：既是为了下面那条「代码里不许出现 'fetch' 字面量」的兜底检查，也是
 *   为了正确性 —— 把字符串一并吃掉的话，`'https://x'` 里的 // 会被当成行注释开头，
 *   把整行后面的代码都吞掉，闸门就在那一行上瞎了。
 *
 * 已知不覆盖：正则字面量里的 // 和 /*（本文件守的 sw.js 里没有正则，真出现了再说），
 * 以及模板字符串 ${} 里嵌套的反引号。这两个都不构成绕过路径，只会让判断更严。
 */
export function stripJsComments(src) {
  return src.replace(
    /("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|(`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match, dq, sq, tpl) => (dq || sq || tpl ? match : ' '),
  );
}

/**
 * 找出源码里所有「注册了 fetch 事件处理」的写法。返回违规说明的数组，空数组 = 干净。
 *
 * 三层，一层比一层粗，故意重叠 —— 单独一条正则太容易被无意间绕过了：
 *
 *   1. addEventListener 直接写 'fetch'。引号三种都认（单、双、反引号），括号、引号、
 *      事件名周围的空白和换行随便加。
 *   2. onfetch 属性。self.onfetch = fn、{ onfetch: fn }、globalThis['onfetch'] 全都
 *      会命中这个词。
 *   3. 兜底：代码里（注释除外）**只要出现 'fetch' 这个字符串字面量**就算违规。
 *      这一层挡的是把事件名绕一道弯的写法：
 *        const EVT = 'fetch'; self.addEventListener(EVT, h);
 *      代价是 sw.js 里从此不能出现任何值为 'fetch' 的字符串常量。这个代价是零：
 *      这个 SW 的完整职责是 install / activate / push / notificationclick，
 *      没有一处需要写出 'fetch' 这四个字母。
 *
 * 剩下的理论缺口（'fet' + 'ch' 这种拼接、f 转义）不管：那已经不是「顺手加一行」，
 * 是蓄意规避，而蓄意规避的人直接删掉这个文件更省事。闸门防的是无意。
 */
export function fetchHandlerViolations(src) {
  const code = stripJsComments(src);
  const found = [];

  // 1. addEventListener('fetch' / "fetch" / `fetch`，空白随意
  if (/addEventListener\s*\(\s*(['"`])fetch\1/.test(code)) {
    found.push("addEventListener 注册了 'fetch' 事件");
  }

  // 2. onfetch 属性赋值（self.onfetch = ...、{ onfetch: ... }、['onfetch'] ...）
  if (/\bonfetch\b/.test(code)) {
    found.push('出现了 onfetch 属性');
  }

  // 3. 兜底：代码里出现 'fetch' 字面量，不管拿它去干什么
  if (/(['"`])fetch\1/.test(code)) {
    found.push("代码里出现了 'fetch' 字符串字面量（事件名不许绕道传入）");
  }

  return found;
}

describe('sw.js 的源码闸门', () => {
  it('文件在它该在的地方 —— public/ 下，Vite 会原样拷进 dist 根目录', () => {
    // 单拎出来断言，是为了让「文件被挪走/删了」报成这一句，而不是下面某条读文件时的
    // 一个看不懂的 ENOENT。SW 的 URL 必须稳定，挪位置本身就是个需要当场知道的改动。
    expect(SW_PATH, '找不到 web/public/sw.js').toBeDefined();
  });

  it('里面没有任何形式的 fetch 事件监听', () => {
    const violations = fetchHandlerViolations(readFileSync(SW_PATH, 'utf8'));
    expect(
      violations,
      `sw.js 里出现了 fetch 处理：${violations.join('；')}\n` +
        '这条红线不许破 —— 理由见 sw.js 顶部和本文件顶部的注释。真要加缓存，' +
        '先在 PR 描述里解释清楚为什么这个 IM 需要离线能力。',
    ).toEqual([]);
  });

  it('该有的两条还在：install → skipWaiting，activate → clients.claim', () => {
    // 闸门只说「不许有什么」，这条补上「必须有什么」：没有 skipWaiting/claim，
    // 新版 SW 要等所有旧页面关掉才接管，真机排查时你根本不知道在跑哪一版。
    const code = stripJsComments(readFileSync(SW_PATH, 'utf8'));
    expect(code).toMatch(/addEventListener\s*\(\s*(['"`])install\1/);
    expect(code).toMatch(/skipWaiting\s*\(/);
    expect(code).toMatch(/addEventListener\s*\(\s*(['"`])activate\1/);
    expect(code).toMatch(/clients\s*\.\s*claim\s*\(/);
  });
});

// 闸门自己也得有人守着。下面这组用例锁的是**检测逻辑本身**：一道只认一种写法的
// 正则等于没有，所以这里把能想到的「顺手会这么写」的形式逐条钉死。
// 少了这组，将来有人重构上面的正则时，很容易在自己不知道的情况下把闸门改瞎 ——
// sw.js 是干净的，所有用例照样全绿。
describe('闸门本身：这些写法都要被挡住', () => {
  const blocked = {
    "单引号：addEventListener('fetch', h)": "self.addEventListener('fetch', (e) => {});",
    '双引号：addEventListener("fetch", h)': 'self.addEventListener("fetch", (e) => {});',
    '反引号（模板字符串）：addEventListener(`fetch`, h)': 'self.addEventListener(`fetch`, (e) => {});',
    '括号和引号之间加空格': "self.addEventListener( 'fetch' , h );",
    '参数换行写': "self.addEventListener(\n  'fetch',\n  handler,\n);",
    'addEventListener 前后有空格': "self.addEventListener  ('fetch', h);",
    '不带 self. 前缀': "addEventListener('fetch', h);",
    'onfetch 属性赋值': 'self.onfetch = (e) => {};',
    'onfetch 不带 self.': 'onfetch = handler;',
    '中括号取属性名': "self['onfetch'] = handler;",
    '事件名先存进变量再传': "const EVT = 'fetch';\nself.addEventListener(EVT, handler);",
    '事件名藏在常量表里': "const E = { FETCH: 'fetch' };\nself.addEventListener(E.FETCH, handler);",
    '和别的监听混在一起': "self.addEventListener('push', a);\nself.addEventListener('fetch', b);",
  };

  for (const [name, source] of Object.entries(blocked)) {
    it(`挡住：${name}`, () => {
      expect(fetchHandlerViolations(source)).not.toEqual([]);
    });
  }

  it('不误伤：注释里提到 fetch 不算违规', () => {
    // 这条不是凑数的 —— sw.js 顶部整段红线注释都在讲 fetch，一旦误伤，
    // 唯一能让闸门变绿的办法就是删掉那段解释「为什么不许加 fetch」的注释。
    const source = [
      "// 永远不许写 self.addEventListener('fetch', ...)，理由见下。",
      '/* 多行注释里也提一句 "fetch" 和 `fetch` 和 onfetch。 */',
      "self.addEventListener('install', () => self.skipWaiting());",
    ].join('\n');
    expect(fetchHandlerViolations(source)).toEqual([]);
  });

  it('不误伤：真实的 sw.js 全文（含那段满是 fetch 的注释）是干净的', () => {
    expect(fetchHandlerViolations(readFileSync(SW_PATH, 'utf8'))).toEqual([]);
  });

  it('去注释不会被字符串里的 // 带偏', () => {
    // 这是上面 stripJsComments 那段说明的可执行版本：如果去注释时把字符串也一并吃掉，
    // 'https://x' 里的 // 会被当成行注释开头，把同一行后面的 fetch 监听整个吞掉。
    const source = "const U = 'https://x'; self.addEventListener('fetch', h);";
    expect(fetchHandlerViolations(source)).not.toEqual([]);
  });
});
