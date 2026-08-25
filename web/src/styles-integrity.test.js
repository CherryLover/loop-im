// 这道闸门是为一次真实事故加的，别删。
//
// 合并 styles.css 的冲突时丢了一个闭合花括号：
//
//   @media (prefers-reduced-motion: reduce) {
//     .avatar-slot__spinner { animation-duration: 2.4s; }
//                                  ← 这里的 } 没了
//   .md .mdimg { ... }             ← 于是后面整段都掉进了这个 media query
//
// 后果是那一整批图片样式**只对开了「减少动态效果」的人生效**，其余人看到的还是旧版面。
// 而这条流水线上没有任何人会发现：tsc 不看 CSS；vite 遇到括号不平衡会自动收口、
// 不报错；jsdom 不计算样式。580 条前端用例、CI 九项，一个都没拦住，靠人肉看出来的。
//
// 写成 .js 而不是 .ts 是有意的：tsconfig 的 include 只覆盖 src 且没开 allowJs，
// 所以 tsc 不会检查这个文件，也就不需要为了一个 node:fs 的 import 去给 web 装
// @types/node。vitest 照常会收它。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// 不用 import.meta.url：vitest 转换后的模块里它不是 file: scheme，fileURLToPath 会抛。
// vitest 的 root 是 web/，所以按 cwd 找；带一个上层候选，免得有人从仓库根跑。
const CSS_PATH = ['src/styles.css', 'web/src/styles.css']
  .map((p) => resolve(process.cwd(), p))
  .find(existsSync);

const CSS = readFileSync(CSS_PATH, 'utf8');

/** 去掉注释，注释里的花括号不算数（`content: "{"` 这类本仓库没有，真出现了再说）。 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) || []).length));

/** 逐字符扫，返回每个块的 { 选择器, 行号, 外层块, 正文 }。
 *  `body` 是这个块 `{}` 之间的原文；at-rule 的 body 里会连子块一起包含，
 *  普通规则里不会有子块（有的话上面那条嵌套用例先红）。 */
function parseBlocks(css) {
  const clean = stripComments(css);
  const blocks = [];
  const stack = [];
  let line = 1;
  let buf = '';
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === '\n') line += 1;
    if (ch === '{') {
      const selector = buf.trim().replace(/\s+/g, ' ');
      const block = { selector, line, ancestors: stack.map((s) => s.selector), body: '' };
      blocks.push(block);
      stack.push({ selector, line, block, contentStart: i + 1 });
      buf = '';
    } else if (ch === '}') {
      if (!stack.length) throw new Error(`第 ${line} 行有多余的 }`);
      const frame = stack.pop();
      frame.block.body = clean.slice(frame.contentStart, i);
      buf = '';
    } else {
      buf += ch;
    }
  }
  return { blocks, unclosed: stack };
}

describe('styles.css 结构完整性', () => {
  it('花括号必须平衡 —— 少一个 } 会让后面整段静默掉进上一个块里', () => {
    const { unclosed } = parseBlocks(CSS);
    const detail = unclosed.map((s) => `第 ${s.line} 行的 "${s.selector}"`).join('、');
    expect(unclosed.length, `这些块没有闭合：${detail}`).toBe(0);
  });

  it('普通选择器不能嵌在别的块里 —— CSS 不支持嵌套，嵌进去等于整条规则失效或被条件化', () => {
    const { blocks } = parseBlocks(CSS);
    // 只有 @media / @supports / @keyframes 这类 at-rule 才允许有子块。
    const nested = blocks.filter((b) => b.ancestors.length > 0
      && !b.ancestors.every((a) => a.startsWith('@')));
    const detail = nested.map((b) => `第 ${b.line} 行 "${b.selector}" 嵌在 "${b.ancestors.join(' > ')}" 里`).join('\n');
    expect(nested.length, `发现嵌套的普通规则：\n${detail}`).toBe(0);
  });

  it('那段图片与查看器的样式必须在顶层，不能被条件化', () => {
    const { blocks } = parseBlocks(CSS);
    // 这几条是事故现场：它们曾经整段掉进 prefers-reduced-motion 里。
    for (const selector of ['.md .mdimg', '.imgview', '.attach-list']) {
      const hit = blocks.find((b) => b.selector === selector);
      expect(hit, `找不到规则 ${selector}，是不是被改名了？改名请同时更新这条用例`).toBeTruthy();
      expect(hit.ancestors, `${selector} 被裹在 ${hit.ancestors.join(' > ')} 里了`).toEqual([]);
    }
  });

  // 会话详情顶栏的免打扰开关（.chat__mute）。
  //
  // 它是「进了会话之后唯一的免打扰入口」：单聊没有成员面板，成员面板在窄版式下又是
  // display:none，所以这个按钮必须一直在顶栏、一直看得见。它的样式一旦整段掉进某个
  // @media / @supports 里，桌面上就会退回成一个没有边框、也不显示「开着」的秃按钮 ——
  // 又是那种 tsc 不看、vite 不报、jsdom 不算、CI 全绿、只有用户看得见的事故。
  // 所以和上面那三条一样，按选择器钉住层级。
  //
  // 这里用 filter 而不是 find：.chat__mute 在窄版式里还有一条只改尺寸的补充规则，
  // 用 find 就变成「谁写在前面测谁」，规则一挪位置这道闸门自己就哑了。
  it('免打扰开关 .chat__mute 的基础样式必须在顶层 —— 只允许窄版式再补一条', () => {
    const MOBILE_MEDIA = '@media (max-width: 720px)';
    const { blocks } = parseBlocks(CSS);
    for (const selector of ['.chat__mute', '.chat__mute--on']) {
      const hits = blocks.filter((b) => b.selector === selector);
      expect(hits.length, `找不到规则 ${selector}，是不是被改名了？改名请同时更新这条用例`).toBeGreaterThan(0);
      expect(
        hits.some((b) => b.ancestors.length === 0),
        `${selector} 一条顶层规则都没有，全被条件化了：${hits.map((b) => `第 ${b.line} 行在 "${b.ancestors.join(' > ')}"`).join('、')}`,
      ).toBe(true);
      for (const hit of hits) {
        const ok = hit.ancestors.length === 0
          || (hit.ancestors.length === 1 && hit.ancestors[0] === MOBILE_MEDIA);
        expect(
          ok,
          `第 ${hit.line} 行的 ${selector} 被裹在 "${hit.ancestors.join(' > ')}" 里，`
          + `只允许顶层或 "${MOBILE_MEDIA}"`,
        ).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 安全区适配（PWA 独立模式：刘海 / 灵动岛 / Home 指示条）
//
// 下面每一条都是「这行字必须在」的笨办法，理由和这个文件本身的存在理由是同一个 ——
// 安全区样式**只在 iOS 独立模式的真机上**才有可见效果：
//   桌面（以及 e2e 跑的无头 Chromium）里 env(safe-area-inset-*) 恒为 0，
//   我们又刻意把每条都写成「原值 + env(...)」的加法，于是结果与原值逐像素相同。
//   这正是「桌面像素级零变化」这条硬约束要的效果，但反过来也意味着：
//   这几行明天被一次合并冲突整段吃掉，tsc 不看 CSS、vite 不报错、
//   jsdom 不算样式、e2e 量出来的数字一个不差 —— 全套 CI 照样全绿，
//   只有真机上的用户会发现底部导航被 Home 指示条压住、点不准。
// 所以只能退回到「断言源码里必须有这行字、而且必须在该在的层级上」。
// 改名 / 挪窝请连着这些用例一起改，别只把用例删掉。
// ---------------------------------------------------------------------------
describe('styles.css 安全区适配', () => {
  const MOBILE_MEDIA = '@media (max-width: 720px)';

  /** 所有**普通规则**（非 at-rule）的块。at-rule 的 body 含子块，会造成误判，排除掉。 */
  const plainRules = () => parseBlocks(CSS).blocks.filter((b) => !b.selector.startsWith('@'));

  /** 选择器为 selector、且规则体里出现 needle 的那些块。 */
  const rulesWith = (selector, needle) =>
    plainRules().filter((b) => b.selector === selector && b.body.includes(needle));

  /** 断言「selector 里必须有 needle，且该规则处在 allowedAncestors 这个层级上」。 */
  function expectSafeArea(selector, needle, allowedAncestors) {
    const hits = rulesWith(selector, needle);
    expect(hits.length, `${selector} 的规则体里找不到 ${needle} —— 安全区适配被改没了`).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(
        hit.ancestors,
        `第 ${hit.line} 行的 ${selector}（带 ${needle}）被裹在 "${hit.ancestors.join(' > ') || '顶层'}" 里，`
        + `应该在 "${allowedAncestors.join(' > ') || '顶层'}"`,
      ).toEqual(allowedAncestors);
    }
  }

  it('每处 env(safe-area-inset-*) 都必须写第二个参数（兜底值）', () => {
    // 桌面上 env() 有定义、返回 0px，兜底值用不上；但在**不认识 env() 的浏览器**里
    // 整条 calc() 会被判无效、整条声明作废，连原来的 10px / 12px 都一起没了。
    // 写上兜底值之后最差也只是退回原值。
    const calls = (stripComments(CSS).match(/env\([^()]*\)/g) || [])
      .filter((c) => c.includes('safe-area-inset'));
    expect(calls.length, '一处 env(safe-area-inset-*) 都没有，安全区适配整段没了？').toBeGreaterThan(0);
    const bare = calls.filter((c) => !c.includes(','));
    expect(bare, `这些 env() 没写兜底值：${bare.join('、')}`).toEqual([]);
  });

  it('带安全区的规则只能在顶层或直接写在 @media (max-width: 720px) 里 —— 不能被别的条件裹住', () => {
    // 这是那次事故的同款防线：整段掉进 prefers-reduced-motion 之类的条件里，
    // 浏览器不报错、构建不报错，只是对绝大多数人一条都没生效。
    const misplaced = plainRules()
      .filter((b) => b.body.includes('safe-area-inset'))
      .filter((b) => !(b.ancestors.length === 0
        || (b.ancestors.length === 1 && b.ancestors[0] === MOBILE_MEDIA)));
    const detail = misplaced.map((b) => `第 ${b.line} 行 "${b.selector}" 在 "${b.ancestors.join(' > ')}" 里`).join('\n');
    expect(misplaced.length, `这些安全区规则被条件化了：\n${detail}`).toBe(0);
  });

  it('.tabbar 的下内边距必须算进 safe-area-inset-bottom —— 否则那 10px 全被 Home 指示条吃掉', () => {
    expectSafeArea('.tabbar', 'safe-area-inset-bottom', [MOBILE_MEDIA]);
  });

  it('顶栏 .chat__head / .convos 必须留出 safe-area-inset-top，且留在顶层', () => {
    // 只能加在真正贴着屏幕顶边的元素上；给 .app 加 padding-top 会把整个 flex 布局
    // 连同底部导航一起往下推，桌面上也跟着变。
    expectSafeArea('.chat__head', 'safe-area-inset-top', []);
    expectSafeArea('.convos', 'safe-area-inset-top', []);
  });

  it('.app__body 必须吃掉左右安全区 —— 横屏时刘海在侧边，不只有上下', () => {
    expectSafeArea('.app__body', 'safe-area-inset-left', []);
    expectSafeArea('.app__body', 'safe-area-inset-right', []);
  });

  it('.tabbar / .toast 在移动端也要各自吃一遍左右安全区 —— 它们不在 .app__body 里', () => {
    expectSafeArea('.tabbar', 'safe-area-inset-left', [MOBILE_MEDIA]);
    expectSafeArea('.toast', 'safe-area-inset-bottom', [MOBILE_MEDIA]);
  });

  it('.sidebar 上下都要留安全区 —— iPad 宽版式下它是唯一贴着屏幕上下边的元素', () => {
    // 用户最早报的就是「iPad 和 iPhone 上不行」。iPad 独立模式走宽版式：
    // .tabbar 被 display:none，顶栏那两条（.chat__head / .convos）管不到侧栏，
    // 于是 logo 钻进状态栏、底部头像按钮压在 Home 指示条上。
    expectSafeArea('.sidebar', 'safe-area-inset-top', []);
    expectSafeArea('.sidebar', 'safe-area-inset-bottom', []);
  });

  it('.composer 要留下安全区（宽版式下它是最底部的元素）', () => {
    expectSafeArea('.composer', 'safe-area-inset-bottom', []);
  });

  it('窄版式必须把 .composer 的下内边距退回原值 —— 否则和 .tabbar 上下各算一遍', () => {
    // 这条守的是**反方向**的错：.composer 的安全区写在顶层（对宽版式生效），
    // 窄版式下它上面还压着 .tabbar，安全区已经由 .tabbar 吃掉，
    // 这里必须取消，否则凭空多顶高一个指示条的厚度。
    // 之所以不用 @media (min-width: 721px) 把顶层那条限制住：那样和
    // max-width: 720px 之间有条缝 —— 视口宽 720.5px 时两个查询都不匹配，
    // .tabbar 已经藏了、.composer 又没拿到安全区，正好漏掉。复用同一个断点没这问题。
    const resets = plainRules().filter((b) => b.selector === '.composer'
      && b.ancestors.length === 1 && b.ancestors[0] === MOBILE_MEDIA
      && /padding-bottom:\s*12px/.test(b.body));
    expect(
      resets.length,
      `${MOBILE_MEDIA} 里找不到 .composer 的 padding-bottom: 12px 复位 —— `
      + '窄屏上 .tabbar 和 .composer 会把下安全区各吃一遍',
    ).toBeGreaterThan(0);
    // 复位就该是个常量：带上 env() 说明有人把「取消」又写回了「适配」。
    for (const r of resets) {
      expect(r.body.includes('safe-area-inset'), `第 ${r.line} 行的 .composer 复位规则里不该出现 env(safe-area-inset-*)`).toBe(false);
    }
  });

  it('.app 高度必须钉在 min(100dvh, --vv-bottom)，且保留 height: 100% 兜底', () => {
    // dvh 是动态视口单位，iOS 上比 100% 稳（100% 会跟着地址栏收放跳）；
    // height: 100% 那条必须留着当老浏览器的兜底 —— 不认识 dvh 的整条声明被忽略。
    //
    // --vv-bottom 是和 lib/keyboard.ts 的契约（iOS 软键盘适配）：键盘弹起时它把
    // 可视区域底边写进这个变量，.app 的底边直接钉在那里。必须是 min()（变量缺席
    // 或异常偏大时退回整屏），且 min-height 要跟着一起 —— 不跟的话键盘弹起时
    // 会把壳又撑回去，所以两个都查。
    const appRules = plainRules().filter((b) => b.selector === '.app' && b.ancestors.length === 0);
    const pin = /min\(100dvh, var\(--vv-bottom, 100dvh\)\)/;
    const h = appRules.filter((b) => new RegExp(`[^-]height:\\s*${pin.source}`).test(b.body));
    const minH = appRules.filter((b) => new RegExp(`min-height:\\s*${pin.source}`).test(b.body));
    const pct = appRules.filter((b) => /height:\s*100%/.test(b.body));
    expect(h.length, '顶层 .app 里找不到 height: min(100dvh, var(--vv-bottom, 100dvh))').toBeGreaterThan(0);
    expect(minH.length, '顶层 .app 里找不到同样钉底的 min-height').toBeGreaterThan(0);
    expect(pct.length, '顶层 .app 的 height: 100% 兜底没了，老浏览器会塌成 0 高').toBeGreaterThan(0);
  });
});
