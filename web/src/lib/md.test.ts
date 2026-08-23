import { describe, expect, it } from 'vitest';
import { initialOf, renderMarkdown } from './md';

describe('Markdown 渲染', () => {
  it('段落与加粗', () => {
    expect(renderMarkdown('第一行\n第二行')).toBe('<p>第一行</p><p>第二行</p>');
    expect(renderMarkdown('**周四** 完成')).toBe('<p><strong>周四</strong> 完成</p>');
  });

  it('列表', () => {
    expect(renderMarkdown('- 接口 2 项未完成\n- 回归测试 1 天'))
      .toBe('<ul><li>接口 2 项未完成</li><li>回归测试 1 天</li></ul>');
  });

  it('行内代码与链接', () => {
    expect(renderMarkdown('等 `/messages/sync`')).toContain('<code>/messages/sync</code>');
    expect(renderMarkdown('见 [文档](https://loop.dev/doc)'))
      .toContain('<a href="https://loop.dev/doc" target="_blank" rel="noreferrer">文档</a>');
  });

  it('图片渲染成 img，保留 alt', () => {
    expect(renderMarkdown('![发版流程](/uploads/a.png)'))
      .toContain('<img alt="发版流程" src="/uploads/a.png">');
  });

  it('@ 提及会被高亮', () => {
    expect(renderMarkdown('@Aria 看一下')).toContain('<strong class="mention">@Aria</strong>');
    expect(renderMarkdown('@全员 站会推迟')).toContain('<strong class="mention">@全员</strong>');
  });

  it('转义 HTML，不会执行注入的脚本', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('图片与链接里的 javascript: 协议会被拦掉', () => {
    expect(renderMarkdown('![x](javascript:alert(1))')).toContain('src="#"');
    expect(renderMarkdown('[x](javascript:alert(1))')).toContain('href="#"');
    expect(renderMarkdown('![x](/uploads/ok.png)')).toContain('src="/uploads/ok.png"');
  });

  it('引号不会撑破属性', () => {
    expect(renderMarkdown('![" onerror="alert(1)](/uploads/a.png)')).not.toContain('onerror="alert(1)"');
  });

  // ---- issue #22：站内相对链接这条路径 ----
  // md.ts 一直允许 /uploads/... 这类站内相对链接，所以恶意附件地址能被包装成一条普通聊天
  // 链接发出来。这条路径在新方案下是无害的：非图片附件在服务端一律落成 .bin，并且回源时带
  // Content-Disposition: attachment + application/octet-stream + nosniff，点开只会下载，
  // 不会有同源页面被渲染出来（服务端一侧的断言在 server/test/issue-22.test.js）。
  // 前端这一侧要保证的是：这类链接绝不被内联，而是渲染成明确的「文件卡片 + 下载」。
  it('站内 /uploads 链接渲染成文件卡片，带 download，不内联', () => {
    const html = renderMarkdown('[发版清单.pdf](/uploads/9f3a.bin)');
    expect(html).toContain('class="filecard"');
    expect(html).toContain('href="/uploads/9f3a.bin"');
    expect(html).toContain('download="发版清单.pdf"');
    expect(html).toContain('点击下载');
    // 不是 iframe/object/img，就是一个链接；正文里也没有任何脚本。
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<script');
  });

  it('伪装成图片的附件链接也只是一张坏图，不会变成可执行页面', () => {
    // 服务端给 .bin 回的是 octet-stream + nosniff，浏览器不会拿它当文档。
    expect(renderMarkdown('![伪装](/uploads/evil.bin)')).toBe('<p><img alt="伪装" src="/uploads/evil.bin"></p>');
  });

  it('文件名里的 @ 和 ** 不会把标签属性撑破', () => {
    // @提及、加粗这些行内规则是在标签生成之后跑的，属性值必须先被占位保护起来，
    // 否则 download="@报告.pdf" 会被改写成 download="<strong class="mention">…"。
    const html = renderMarkdown('[@报告**终版**.pdf](/uploads/9f3a.bin)');
    expect(html).toContain('download="@报告**终版**.pdf"');
    expect(html).toContain('href="/uploads/9f3a.bin"');
  });

  it('站外链接照旧是普通链接，不会被当成附件卡片', () => {
    const html = renderMarkdown('[文档](https://loop.dev/doc)');
    expect(html).not.toContain('filecard');
    expect(html).toContain('target="_blank"');
  });

  it('data:image/svg+xml 被挡掉（SVG 是可执行的 XML）', () => {
    expect(renderMarkdown('![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)')).toContain('src="#"');
    // 位图形式的 data URL 不受影响。
    expect(renderMarkdown('![x](data:image/png;base64,iVBORw0KGgo=)')).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });

  it('空内容渲染成空串', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   ')).toBe('');
  });
});

// ---- 视频内联播放 ----
// 判据是**服务端生成的扩展名**（/uploads/<uuid>.mp4|.webm），不是 Markdown 写法：
// key 由服务端按真实字节嗅探后拼出来，用户的原文件名不参与 URL；而写成 ![](…) 还是
// [](…) 完全是发消息的人（或 AI、老客户端）说了算的。只按语法分档，同一个附件会因为
// 当初谁怎么打的那行字而有两种表现。
//
// 说明一句：jsdom 里 <video> 的播放 API 全是桩，这里只能断言渲染出来的元素和属性，
// 「点了真的能播、Range 请求真的发出去」这一层没有被单测覆盖，要靠真实浏览器/e2e。
describe('视频附件内联播放', () => {
  it('图片写法指向 .mp4 时渲染成原生播放器', () => {
    const html = renderMarkdown('![演示录屏](/uploads/9f3a.mp4)');
    expect(html).toContain('<video');
    expect(html).toContain('src="/uploads/9f3a.mp4"');
    expect(html).not.toContain('<img');
  });

  it('链接写法指向 .webm 时同样是播放器，不是文件卡片', () => {
    const html = renderMarkdown('[演示录屏.webm](/uploads/9f3a.webm)');
    expect(html).toContain('<video');
    expect(html).not.toContain('filecard');
    expect(html).not.toContain('点击下载');
  });

  it('带上 controls / preload=metadata / playsinline', () => {
    const html = renderMarkdown('[片子](/uploads/9f3a.mp4)');
    expect(html).toContain('controls');
    // 一屏里滚过几个视频，preload=auto 会把每一个都拉下来，流量吃不消。
    expect(html).toContain('preload="metadata"');
    expect(html).not.toContain('preload="auto"');
    // 不写 playsinline，iOS Safari 一点播放就强制全屏接管。
    expect(html).toContain('playsinline');
  });

  it('没有引入任何播放器依赖：就是一个原生 <video>，没有脚本、没有 iframe', () => {
    const html = renderMarkdown('[片子](/uploads/9f3a.mp4)');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('data-');
  });

  it('文件名进 aria-label，里面的 @ 和 ** 不会把属性撑破', () => {
    const html = renderMarkdown('[@晨会**回放**.mp4](/uploads/9f3a.mp4)');
    expect(html).toContain('aria-label="@晨会**回放**.mp4"');
    expect(html).toContain('src="/uploads/9f3a.mp4"');
  });

  it('非视频后缀不受影响：.bin 还是文件卡片，.png 还是图片', () => {
    expect(renderMarkdown('[发版清单.pdf](/uploads/9f3a.bin)')).toContain('class="filecard"');
    expect(renderMarkdown('![图](/uploads/a.png)')).toContain('<img');
  });

  it('站外的 .mp4 不认：只有站内附件才配播放器', () => {
    // 服务端只为 /uploads/ 背书。外链的后缀是任何人都能编的，不能凭它就吐一个播放器出来。
    const html = renderMarkdown('[外链](https://evil.example/x.mp4)');
    expect(html).not.toContain('<video');
    expect(html).toContain('target="_blank"');
  });

  it('伪协议照旧被拦掉，不会变成播放器', () => {
    expect(renderMarkdown('[x](javascript:alert(1).mp4)')).not.toContain('<video');
  });
});

// ---- Markdown 扩展 ----
describe('Markdown 扩展：标题 / 有序列表 / 斜体 / 引用', () => {
  it('一到三级标题', () => {
    expect(renderMarkdown('# 发版说明')).toBe('<h1>发版说明</h1>');
    expect(renderMarkdown('## 已知问题')).toBe('<h2>已知问题</h2>');
    expect(renderMarkdown('### 细节')).toBe('<h3>细节</h3>');
    // 四级不做，原样当正文。
    expect(renderMarkdown('#### 太深了')).toBe('<p>#### 太深了</p>');
    // 井号后面没有空格的不是标题（#1 这种编号很常见）。
    expect(renderMarkdown('#1 号问题')).toBe('<p>#1 号问题</p>');
  });

  it('有序列表，`1.` 和 `1)` 都认', () => {
    expect(renderMarkdown('1. 冻结代码\n2. 打包\n3. 灰度'))
      .toBe('<ol><li>冻结代码</li><li>打包</li><li>灰度</li></ol>');
    expect(renderMarkdown('1) 甲\n2) 乙')).toBe('<ol><li>甲</li><li>乙</li></ol>');
  });

  it('无序和有序相邻时是两个列表，不会混进同一个', () => {
    expect(renderMarkdown('- 甲\n1. 乙')).toBe('<ul><li>甲</li></ul><ol><li>乙</li></ol>');
  });

  it('斜体', () => {
    expect(renderMarkdown('这是 *重点*')).toBe('<p>这是 <em>重点</em></p>');
    expect(renderMarkdown('***又粗又斜***')).toContain('<strong>又粗又斜</strong>');
    // 无序列表那条规则要求 * 后面跟空格，所以它不会被斜体抢走。
    expect(renderMarkdown('* 甲\n* 乙')).toBe('<ul><li>甲</li><li>乙</li></ul>');
    // 落单的一个 * 不跨行乱配。
    expect(renderMarkdown('5 * 3\n是 15')).toBe('<p>5 * 3</p><p>是 15</p>');
  });

  it('下划线写法不做斜体：它会把 target="_blank" 这样的属性连起来吃掉', () => {
    const html = renderMarkdown('[甲](https://a.dev) 和 [乙](https://b.dev)');
    expect(html).not.toContain('<em>');
    expect((html.match(/target="_blank"/g) || []).length).toBe(2);
    // 顺带：user_id 这种标识符也不会被误判。
    expect(renderMarkdown('字段 user_id 和 order_id')).toBe('<p>字段 user_id 和 order_id</p>');
  });

  it('引用，连续几行合成一块', () => {
    expect(renderMarkdown('> 客户说下周一要看到')).toBe('<blockquote><p>客户说下周一要看到</p></blockquote>');
    expect(renderMarkdown('> 第一行\n> 第二行'))
      .toBe('<blockquote><p>第一行</p><p>第二行</p></blockquote>');
    // 引用结束后回到普通段落。
    expect(renderMarkdown('> 引用\n正文')).toBe('<blockquote><p>引用</p></blockquote><p>正文</p>');
  });

  it('引用里的行内规则照常生效', () => {
    expect(renderMarkdown('> @Aria 看一下 **这个**'))
      .toContain('<strong class="mention">@Aria</strong>');
  });

  it('刻意不做表格和原始 HTML', () => {
    // 表格写法只会被当成普通段落，不会排出 <table>（气泡这么窄，排出来也没法看）。
    const table = renderMarkdown('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |');
    expect(table).not.toContain('<table');
    // HTML 一律转义。这个渲染器的输出是直接注进 DOM 的，放行等于把 XSS 开在自家门口。
    expect(renderMarkdown('<b>粗</b>')).toBe('<p>&lt;b&gt;粗&lt;/b&gt;</p>');
  });
});

describe('代码块里的东西一律是字面量', () => {
  it('代码块渲染成 pre + code，且独立成块，不被 <p> 包住', () => {
    const html = renderMarkdown('```\nnpm test\n```');
    expect(html).toBe('<pre class="mdcode"><code>npm test</code></pre>');
  });

  it('语言标注不影响渲染', () => {
    expect(renderMarkdown('```js\nconst a = 1;\n```'))
      .toBe('<pre class="mdcode"><code>const a = 1;</code></pre>');
  });

  it('代码块里的 **粗体**、@某人、![图]() 都不解析', () => {
    const html = renderMarkdown('```\n**粗体** @Aria ![图](/uploads/a.png) *斜* `内联`\n```');
    expect(html).not.toContain('<strong');
    expect(html).not.toContain('<em');
    expect(html).not.toContain('mention');
    expect(html).not.toContain('<img');
    // 原样留在代码块里。
    expect(html).toContain('**粗体** @Aria ![图](/uploads/a.png) *斜* `内联`');
  });

  it('代码块里以 # / - / > 开头的行不会变成标题、列表、引用', () => {
    const html = renderMarkdown('```\n# 注释\n- 项\n> 引用\n1. 编号\n```');
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('<ul');
    expect(html).not.toContain('<ol');
    expect(html).not.toContain('<blockquote');
    expect(html).toContain('# 注释');
    expect(html).toContain('&gt; 引用');
  });

  it('代码块里的 HTML 仍然是转义过的，不会被执行', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('代码块前后的正文照常渲染', () => {
    expect(renderMarkdown('先看这个：\n```\ncode\n```\n再看那个'))
      .toBe('<p>先看这个：</p><pre class="mdcode"><code>code</code></pre><p>再看那个</p>');
  });

  it('多行代码块保留换行', () => {
    expect(renderMarkdown('```\n一\n二\n```')).toContain('一\n二');
  });

  it('只开不闭的 ``` 不成块，也不会吞掉后面的正文', () => {
    const html = renderMarkdown('```\n没闭合\n还有正文');
    expect(html).not.toContain('<pre');
    expect(html).toContain('还有正文');
  });

  it('行内代码同样不解析里面的行内规则', () => {
    expect(renderMarkdown('别写成 `**粗体**`')).toBe('<p>别写成 <code>**粗体**</code></p>');
    expect(renderMarkdown('别 at `@Aria`')).not.toContain('mention');
    expect(renderMarkdown('这是 `![图](/uploads/a.png)`')).not.toContain('<img');
  });
});

describe('恶意输入仍然被转义', () => {
  /**
   * 按字符串比对「有没有 onerror=」是不够的：转义之后的 &lt;img … onerror=…&gt; 是一段
   * 纯文本，出现这几个字也无所谓。真正要证明的是「它没有变成节点」，所以这里把渲染结果
   * 真的注进 DOM（这也正是产品里的用法），再看有没有长出危险元素或事件属性。
   */
  const inject = (input: string) => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(input);
    return host;
  };
  const DANGEROUS = 'script,iframe,object,embed,svg,style,form,link,meta';

  const cases: [string, string][] = [
    ['img 的 onerror', '<img src=x onerror=alert(1)>'],
    ['svg 的 onload', '<svg onload=alert(1)>'],
    ['iframe', '<iframe src="javascript:alert(1)"></iframe>'],
    ['属性里的引号', '" onmouseover="alert(1)'],
    ['标题里塞标签', '# <img src=x onerror=alert(1)>'],
    ['引用里塞标签', '> <script>alert(1)</script>'],
    ['有序列表里塞标签', '1. <script>alert(1)</script>'],
    ['代码块里塞标签', '```\n<img src=x onerror=alert(1)>\n```'],
    ['行内代码里塞标签', '`<img src=x onerror=alert(1)>`'],
    ['斜体里塞标签', '*<script>alert(1)</script>*'],
    ['链接名里塞标签', '[<img src=x onerror=alert(1)>](/uploads/a.bin)'],
    ['视频名里塞标签', '[<img src=x onerror=alert(1)>](/uploads/a.mp4)'],
  ];
  for (const [name, input] of cases) {
    it(`${name} 不会长成真节点`, () => {
      const host = inject(input);
      expect(host.querySelector(DANGEROUS)).toBeNull();
      for (const el of host.querySelectorAll('*')) {
        for (const attr of el.attributes) {
          expect(attr.name.startsWith('on')).toBe(false);
        }
      }
      // 注入的 <img src=x> 也没有真的变成一个会去发请求的 img。
      expect(host.querySelector('img[src="x"]')).toBeNull();
    });
  }

  it('被转义的标签以文本形式原样显示出来', () => {
    const host = inject('# <img src=x onerror=alert(1)>');
    expect(host.querySelector('h1')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('属性值里的危险文本留在属性里，撑不破标签', () => {
    // aria-label / download 这类属性值来自用户，转义之后放进带引号的属性里是安全的：
    // 引号已经变成 &quot;，闭不掉这个属性，浏览器把整串当一个值解析。
    const host = inject('[<img src=x onerror=alert(1)>](/uploads/a.mp4)');
    const video = host.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('aria-label')).toBe('<img src=x onerror=alert(1)>');
    expect(host.querySelectorAll('*').length).toBe(2);   // 只有 <p> 和 <video>，没多长东西
  });

  it('正文里混进 U+0000 也指不到占位槽上', () => {
    // 占位槽用 U+0000 当分隔符。正文里真出现一个 NUL 就有机会伪造出 \u0000 0 \u0000
    // 这样的记号，指向别人的槽位。escapeHtml 进门先把它剔掉，这条路就堵死了。
    const html = renderMarkdown('\u00000\u0000 [文件](/uploads/9f3a.bin)');
    expect(html).toContain('class="filecard"');
    expect(html).toContain('<p>0 <a class="filecard"');
    expect(html).not.toContain('\u0000');
  });
});

describe('头像首字', () => {
  it('中文取第一个字，Aria 用两位缩写', () => {
    expect(initialOf('林悦')).toBe('林');
    expect(initialOf('Aria')).toBe('Ar');
    expect(initialOf('')).toBe('?');
  });
});
