// Web Push 订阅的存取层。路由只管鉴权和 HTTP 语义，「什么样的订阅算合法」
// 和「同一个 endpoint 再报一次怎么办」这两件事定死在这里。
//
// 三条贯穿全文件的前提：
//
// 1. **iOS 不支持 `pushsubscriptionchange` 事件**（见 docs/PWA-与推送改造方案.md A.2 ⑪）。
//    前端拿不到「你的订阅失效了」这个通知，唯一可行的办法是每次启动无条件重新
//    `subscribe()` 再上报一次。所以写入必须是 **upsert**：既不能「已存在就报错」，
//    也不能每次插一条新行 —— 那样一台 iPhone 开一个月就攒出几十行同 endpoint 的垃圾，
//    每次群发都要对同一台设备推几十遍。
//
// 2. **endpoint 唯一是安全边界**（唯一索引见 db.js）。同一台设备换个人登录，浏览器给的
//    endpoint 不变；upsert 时必须**覆盖 user_id**，否则前一个人会继续收到后一个人的
//    消息摘要。这不是体验问题，是数据泄露。
//
// 3. **格式校验在入库之前做完**。p256dh / auth 是客户端给的 base64url，长度不对的话
//    要等到 RFC 8291 加密那一步才炸 —— 那时候是在群发的循环里，一条坏订阅每次都换来
//    一次注定失败的请求，而且报错指向加密函数，跟「几个月前某台设备报了个坏 key」
//    对不上号。所以坏数据一律挡在门外，不进库。
import { all, get, now, run, uid } from './db.js';

/**
 * endpoint 的长度上限。推送服务给的 endpoint 是 URL，苹果和 FCM 的都在 200 字符上下，
 * 给到 2048 是留足余量，同时挡住「把一兆字符串塞进 TEXT 列」这种最省事的攻击。
 */
const MAX_ENDPOINT_LENGTH = 2048;

/** deviceId 是 2C 判「这台设备在不在线」的键，只要能当字典 key 就行，长度按 UUID 留足。 */
const MAX_DEVICE_ID_LENGTH = 128;

/**
 * `ua` 只留前 120 字符：它的用途是将来在设置界面里告诉用户「你在哪几台设备上开了通知」，
 * 那个场景 120 字符足够认出机型；整条 User-Agent 存下来只是让库变胖。
 * 界面这一版不做，但字段先写上 —— 回填不了的东西不要等到要用时才加。
 */
const MAX_UA_LENGTH = 120;

/**
 * RFC 8291 §3.1：`p256dh` 是 P-256 公钥的**非压缩点**格式，固定 65 字节，首字节 0x04；
 * `auth` 是 16 字节的认证密钥。两个长度都是协议钉死的，不是经验值。
 */
const P256DH_BYTES = 65;
const AUTH_BYTES = 16;
const UNCOMPRESSED_POINT_TAG = 0x04;

/** base64url 的字母表：只有这 64 个字符加上可省略的 '=' 补位。'+' 和 '/' 是标准 base64，不收。 */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * 把一段 base64url 解成 Buffer，长度不对或字符不合法一律 null。
 *
 * **必须自己验字符集**：`Buffer.from(s, 'base64url')` 是宽容的，遇到不认识的字符直接
 * 跳过而不报错，所以 `'!!!!' + 合法串` 也能解出「长度正好」的结果。只看解码后的字节数
 * 等于把校验交给了一个专门设计成不校验的函数。
 */
function decodeBase64url(value, expectedBytes) {
  if (typeof value !== 'string') return null;
  // 补位可有可无（浏览器给的是不带补位的），去掉之后再验字符集。
  const body = value.replace(/=+$/, '');
  if (!BASE64URL.test(body)) return null;
  const buf = Buffer.from(body, 'base64url');
  if (buf.length !== expectedBytes) return null;
  return buf;
}

/**
 * endpoint 必须是能解析的 **https** URL。
 *
 * 只认 https 有两个理由：推送服务（Apple / FCM / Mozilla）给出的本来就都是 https；
 * 而放开协议之后，一个 `file://` 或 `http://内网地址` 的 endpoint 会让服务端在发推送时
 * 拿着自己的出站权限去访问调用方指定的地址 —— 那是一个 SSRF 入口。
 */
function normalizeEndpoint(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_ENDPOINT_LENGTH) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return raw;
}

/** deviceId：非空、不超长、不含控制字符（它会被原样塞进日志和 JSON）。 */
function normalizeDeviceId(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_DEVICE_ID_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}

/** User-Agent 头 → 入库的 ua 列。拿不到就是 NULL，这一列本来就可空。 */
export const normalizeUa = (value) =>
  (typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_UA_LENGTH) : null);

/**
 * 校验一条订阅上报。**通过**返回 `{ ok: true, value }`，`value` 可以直接喂给
 * `upsertSubscription`；**不通过**返回 `{ ok: false, error }`，`error` 是给用户看的中文。
 *
 * 分开成一个纯函数而不是写在路由里：这样「什么算合法」有独立的用例可测，
 * 不用每验一个边界就起一次 HTTP 服务。
 */
export function validateSubscriptionInput({ deviceId, subscription } = {}) {
  const device = normalizeDeviceId(deviceId);
  if (!device) return { ok: false, error: 'deviceId 不合法' };

  const endpoint = normalizeEndpoint(subscription?.endpoint);
  if (!endpoint) return { ok: false, error: 'endpoint 必须是合法的 https URL' };

  const p256dh = subscription?.keys?.p256dh;
  const decodedP256dh = decodeBase64url(p256dh, P256DH_BYTES);
  if (!decodedP256dh || decodedP256dh[0] !== UNCOMPRESSED_POINT_TAG) {
    // 首字节不是 0x04 就不是非压缩点，后面 RFC 8291 的 ECDH 一定失败。
    // 与其存进去等每次群发都失败一次，不如现在就说清楚。
    return { ok: false, error: 'p256dh 不是合法的 base64url P-256 公钥' };
  }

  const auth = subscription?.keys?.auth;
  if (!decodeBase64url(auth, AUTH_BYTES)) {
    return { ok: false, error: 'auth 不是合法的 base64url 认证密钥' };
  }

  return { ok: true, value: { deviceId: device, endpoint, p256dh, auth } };
}

/** 库里的一行 → 对外的 camelCase 形状。2C 只认这几个字段。 */
const toSubscription = (row) => ({
  id: row.id,
  userId: row.user_id,
  deviceId: row.device_id,
  endpoint: row.endpoint,
  p256dh: row.p256dh,
  auth: row.auth,
});

/**
 * 写入一条订阅。同一个 endpoint 再报一次是**更新**，不是新增，也不是错误（见文件头 ①）。
 *
 * 冲突时覆盖 user_id / device_id / 两把密钥：这台设备现在属于谁、密钥是什么，
 * 以最后一次上报为准（见文件头 ②）。
 *
 * `fail_count` 和 `last_ok_at` 一起清空：重新 subscribe 出来的是一副全新的密钥，
 * 上一副密钥推成功过几次、连续失败过几次，跟它没有关系。
 *
 * `created_at` 只在**换人**时才重置。同一个人每次启动都会重报一次（iOS 那条路径），
 * 每次都刷新 created_at 的话这一列就只剩「上次开了 App」的意思，
 * 「这台设备什么时候开的通知」就永远查不到了。
 *
 * 返回写入后的那一行（camelCase）。
 */
export function upsertSubscription({ userId, deviceId, endpoint, p256dh, auth, ua = null }) {
  run(
    `INSERT INTO push_subscriptions
       (id, user_id, device_id, endpoint, p256dh, auth, ua, created_at, last_ok_at, fail_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id    = excluded.user_id,
       device_id  = excluded.device_id,
       p256dh     = excluded.p256dh,
       auth       = excluded.auth,
       ua         = excluded.ua,
       last_ok_at = NULL,
       fail_count = 0,
       created_at = CASE WHEN push_subscriptions.user_id = excluded.user_id
                         THEN push_subscriptions.created_at
                         ELSE excluded.created_at END`,
    uid('ps'), userId, deviceId, endpoint, p256dh, auth, ua, now(),
  );
  return toSubscription(get('SELECT * FROM push_subscriptions WHERE endpoint = ?', endpoint));
}

/**
 * 一批用户名下的全部订阅（2C 群发时一次取回，不要在收件人循环里逐个查）。
 * 传空数组返回空数组 —— 不能让它退化成 `IN ()`，那是一句语法错误的 SQL。
 */
export function subscriptionsFor(userIds) {
  const ids = [...new Set(userIds || [])].filter(Boolean);
  if (!ids.length) return [];
  return all(
    `SELECT * FROM push_subscriptions
     WHERE user_id IN (${ids.map(() => '?').join(',')})
     ORDER BY created_at, rowid`,
    ...ids,
  ).map(toSubscription);
}

/**
 * 按 endpoint 删一条订阅，**不看归属**。这是给 2C 用的：推送服务回 404/410 说
 * 「这个 endpoint 已经没了」时，不管它记在谁名下都该清掉。
 *
 * ⚠️ 用户发起的退订**不要**用这个，用 `deleteSubscriptionForUser` —— 否则任何人
 * 拿着别人的 endpoint 就能把别人的推送关掉。
 */
export const deleteSubscription = (endpoint) =>
  run('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint).changes > 0;

/**
 * 用户主动退订：只删**自己名下**那一条。
 *
 * 一个人可以有多台设备（手机 + 平板 + 桌面各一行），所以按 endpoint 精确删，
 * 不能按 user_id 一把清 —— 在手机上关掉通知不该把平板上的也关了。
 */
export const deleteSubscriptionForUser = (endpoint, userId) =>
  run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, userId).changes > 0;

/** 清空某个账号的全部订阅（账号停用时用，见 routes/users.js）。返回删掉几行。 */
export const deleteSubscriptionsForUser = (userId) =>
  run('DELETE FROM push_subscriptions WHERE user_id = ?', userId).changes;

/**
 * 记一次推送的成败。成功清零 `fail_count` 并写 `last_ok_at`，失败只把计数 +1。
 *
 * 这两列纯给运维排查用（「这台设备连着失败 30 次了」），**不参与「该不该推」的判定** ——
 * 判定在 2C，靠的是 SSE 在线状态和免打扰设置。失败到一定次数要不要自动清掉那一行，
 * 是推送服务明确回 404/410 时才该做的事（那时候用 `deleteSubscription`），
 * 不能靠计数猜：网络抖动攒起来的失败次数和「订阅真没了」是两码事。
 */
export function markPushResult(endpoint, ok) {
  if (ok) {
    return run(
      'UPDATE push_subscriptions SET fail_count = 0, last_ok_at = ? WHERE endpoint = ?',
      now(), endpoint,
    ).changes > 0;
  }
  return run(
    'UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE endpoint = ?',
    endpoint,
  ).changes > 0;
}
