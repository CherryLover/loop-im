/**
 * 结构化日志：每条一行 JSON，打到 stdout。
 *
 * 为什么是 stdout 而不是写文件：容器里 stdout 本来就被 Docker 收着，
 * `docker compose logs` 就能导出，不用自己处理轮转和磁盘占用。
 *
 * ── 红线：以下内容永远不许进日志 ──────────────────────────────
 * 消息正文、密码（含哈希）、JWT、AI 的 api_key、附件内容。
 * 日志的留存时间和访问范围都比数据库宽松得多，正文一旦进来，
 * 等于把明文消息又抄了一份到一个更容易被看到的地方。
 * 要定位问题请记 id（conversationId / messageId / userId）和长度，不要记内容。
 *
 * redact() 是**兜底**不是许可：它按字段名拦掉一批明显敏感的键，
 * 但没列进去的键它拦不住。调用方仍然要自己想清楚传了什么。
 */

/** 字段名命中这些就替换成 [已隐去]。大小写和下划线/驼峰都算。 */
const SECRET_KEYS = [
  'password', 'passwordhash', 'hash', 'token', 'accesstoken', 'refreshtoken',
  'authorization', 'apikey', 'secret', 'jwt', 'cookie',
  // 正文类：宁可误伤也不要漏
  'body', 'text', 'content', 'message', 'preview', 'draft', 'plain',
];

const normalizeKey = (key) => key.toLowerCase().replace(/[_-]/g, '');
const isSecret = (key) => SECRET_KEYS.includes(normalizeKey(key));

/** 单个字段值的上限：日志不是用来存数据的，超长一律截断。 */
const MAX_VALUE_LENGTH = 200;

function clean(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…[共${value.length}字]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (depth >= 2) return '[层级过深]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => clean(v, depth + 1));
  if (typeof value === 'object') return redact(value, depth + 1);
  return String(value);
}

function redact(fields, depth = 0) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    out[key] = isSecret(key) ? '[已隐去]' : clean(value, depth);
  }
  return out;
}

/**
 * 测试里默认闭嘴：几百条用例每条都打日志，真正的失败信息会被淹掉。
 * 需要在测试里看日志就设 LOG_IN_TEST=1。
 */
const silent = () => process.env.NODE_ENV === 'test' && process.env.LOG_IN_TEST !== '1';

function write(level, event, fields) {
  if (silent()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...redact(fields),
  });
  // warn/error 走 stderr，info 走 stdout：容器里两条流可以分开收。
  if (level === 'info') console.log(line);
  else console.error(line);
}

/** 正常的关键事件：登录、限流触发、上传、AI 调用、管理动作。 */
export const logEvent = (event, fields = {}) => write('info', event, fields);

/** 不正常但还能继续跑：限流拒绝、上传被拒、外部依赖降级。 */
export const logWarn = (event, fields = {}) => write('warn', event, fields);

/** 出错了。err 会被压成 { name, message }，堆栈另外单独给。 */
// 注意这里传的是 Error 本身，不是 { name, message } —— clean() 有一条专门的 Error 分支，
// 会原样压成 { name, message }。摊平成普通对象反而会被 redact 当成普通字段处理，
// message 命中 SECRET_KEYS 变成「[已隐去]」，错误日志就只剩一个类型名，等于白记。
export const logError = (event, err, fields = {}) => write('error', event, {
  ...fields,
  err: err instanceof Error ? err : String(err),
  stack: err instanceof Error && process.env.LOG_STACK !== '0' ? err.stack : undefined,
});

/** 测试用：把 redact 单独暴露出来，方便断言红线真的守住了。 */
export const __redactForTest = redact;
