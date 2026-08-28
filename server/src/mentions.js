// "@提及" 的解析：@某人 / @全员。从退役的 ai.js 里拆出来的通用能力——
// 提及决定「@我」未读与（将来）AI 用户的触发，与具体某个 AI 无关。
const ALL_ALIASES = ['全员', '所有人', 'everyone', 'all'];
// 邮箱本地部分允许出现的字符：@ 紧跟在它们后面时是地址（zhou@example.com）而不是提及。
// 只挡 ASCII，这样「请@李明」这种中文里紧贴着写的 @ 仍然算提及。
const EMAIL_LOCAL = /[a-z0-9._%+-]/i;
const ASCII_WORD = /[a-z0-9_]/i;

/** 会话里所有可被 @ 的别名，长的排前面，用于最长匹配。 */
function mentionAliases(roster) {
  const byAlias = new Map();                       // 小写别名 -> 命中的 id 集合
  const add = (alias, id) => {
    const key = String(alias || '').trim().toLowerCase();
    if (!key) return;
    if (!byAlias.has(key)) byAlias.set(key, new Set());
    byAlias.get(key).add(id);
  };
  for (const alias of ALL_ALIASES) add(alias, 'all');
  for (const u of roster || []) {
    add(u.name, u.id);
    add(String(u.name || '').replace(/\s+/g, ''), u.id);   // 「Li Ming」也认 @LiMing
  }
  return [...byAlias.entries()].sort((a, b) => b[0].length - a[0].length);
}

/**
 * Resolve "@名字" / "@全员" in a message body against the conversation roster.
 *
 * 不能拿每个名字去正文里做 includes()：中文没有词边界，群里同时有「李」和「李明」时
 * 「@李明」会把两个人都命中，正文里的邮箱地址也会误命中名字。而 parseMentions 的结果
 * 决定「@我」未读（将来还有 AI 用户的触发），误匹配等于打扰错人。
 *
 * 改成反向匹配：从正文里逐个扫出 @，跳过邮箱位置的 @，再拿 @ 后面的文本去和成员别名
 * 做最长前缀匹配 —— 同名互为前缀时长的赢；英文别名额外要求右侧不是字母数字，
 * 免得 @allow 命中 all、@Anna 命中 Ann。
 */
export function parseMentions(body, roster) {
  const text = String(body || '').toLowerCase();
  const aliases = mentionAliases(roster);
  const found = new Set();
  for (let i = text.indexOf('@'); i !== -1; i = text.indexOf('@', i + 1)) {
    if (i > 0 && EMAIL_LOCAL.test(text[i - 1])) continue;      // xxx@example.com
    for (const [alias, ids] of aliases) {
      if (!text.startsWith(alias, i + 1)) continue;
      const next = text[i + 1 + alias.length];
      if (next && ASCII_WORD.test(alias.at(-1)) && ASCII_WORD.test(next)) continue;
      for (const id of ids) found.add(id);
      break;                                                    // 最长的那个别名说了算
    }
  }
  return [...found];
}
