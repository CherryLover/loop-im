/**
 * `src/web-push.js` 的对照测试。
 *
 * 这个文件的重点不是「覆盖率」，是**用规范里的官方测试向量证明加密实现是对的**。
 * 加密代码「差不多对」是最糟的状态：推送服务照样返回 201，
 * 服务端日志一片绿，只有用户的手机上什么都不响，而且没有任何地方会告诉你哪一步错了。
 *
 * 所以下面前两组用例是逐字节比对，向量原文抄自：
 *   - RFC 8291 §5 + Appendix A（内容加密）https://www.rfc-editor.org/rfc/rfc8291.txt
 *   - RFC 8292 §2.4（VAPID 的 Authorization 头）https://www.rfc-editor.org/rfc/rfc8292.txt
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  verify as cryptoVerify,
} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  __internals,
  decodeBase64Url,
  encodeBase64Url,
  encryptPayload,
  isGoneStatus,
  sendPush,
  validateVapidKeys,
  validateVapidSubject,
  vapidHeaders,
} from '../src/web-push.js';

const b64 = (s) => Buffer.from(s, 'base64url');

// ───────────────────────────────────────────────────────────────────────
// RFC 8291 §5 / Appendix A 的官方测试向量，一字不改
// ───────────────────────────────────────────────────────────────────────
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  plaintextB64: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  // Appendix A 的中间值
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  keyInfo:
    'V2ViUHVzaDogaW5mbwAEJXGyvs3942BVGq8e0PTNNmwRzr5VX4m8t7GGpTM5FzFo7OLr4BhZe9MEebhuPI-OztV3' +
    'ylkYfpJGmQ22ggCLDgT-M_SrDepxkU21WCP3O1SUj0EwbZIHMtu5pZpTKGSCIA5Zent7wmC6HCJ5mFgJkuk5cwAv' +
    'MBKiiujwa7t45ewP',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  cekInfo: 'Q29udGVudC1FbmNvZGluZzogYWVzMTI4Z2NtAA',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonceInfo: 'Q29udGVudC1FbmNvZGluZzogbm9uY2UA',
  nonce: '4h_95klXJ5E_qnoN',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  paddedPlaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24C',
  ciphertextOnly: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  // §5 的最终结果（header || ciphertext）
  full:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('RFC 8291 §5 官方测试向量：加密结果逐字节相同', () => {
  const out = encryptPayload({
    p256dh: RFC8291.uaPublic,
    auth: RFC8291.authSecret,
    plaintext: RFC8291.plaintext,
    // 生产路径这两个是随机的；这里注入向量给的固定值，否则结果不可复现。
    salt: b64(RFC8291.salt),
    senderPrivateKey: b64(RFC8291.asPrivate),
  });

  assert.equal(encodeBase64Url(out), RFC8291.full, 'RFC 8291 §5 的最终密文对不上');

  // 144 = 86(头部) + 41(明文) + 1(padding 分隔符) + 16(GCM tag)。
  // ⚠️ §5 那个 HTTP 例子里写的是 `Content-Length: 145`，那是规范自己的笔误 ——
  // 它给出的 base64url 正文是 192 个字符，正好 144 字节。
  // 勘误 5230（由 RFC 作者本人 2018-01-07 提交）已把它更正为 144：
  // https://errata.rfc-editor.org/search/?rfc_number=8291
  assert.equal(out.length, 144);
});

test('RFC 8291 Appendix A：每一步中间值都对得上', () => {
  const derived = __internals.deriveFromRawKeys({
    uaPublic: b64(RFC8291.uaPublic),
    asPrivate: b64(RFC8291.asPrivate),
    authSecret: b64(RFC8291.authSecret),
    salt: b64(RFC8291.salt),
  });

  // 只断言最终密文的话，某一步错了只知道「结果不对」，不知道错在哪。
  // 这几条把每一步分别钉住：改坏哪个 info 串，就只有对应那条会红。
  assert.equal(encodeBase64Url(derived.asPublic), RFC8291.asPublic, 'as_public 对不上');
  assert.equal(encodeBase64Url(derived.sharedSecret), RFC8291.ecdhSecret, 'ecdh_secret 对不上');
  assert.equal(encodeBase64Url(derived.keyInfo), RFC8291.keyInfo, 'key_info 对不上');
  assert.equal(encodeBase64Url(derived.ikm), RFC8291.ikm, 'IKM 对不上');
  assert.equal(encodeBase64Url(derived.cek), RFC8291.cek, 'CEK 对不上');
  assert.equal(encodeBase64Url(derived.nonce), RFC8291.nonce, 'NONCE 对不上');

  // 两个 info 常量本身也对一遍（Appendix A 给了它们的 base64url）
  assert.equal(encodeBase64Url(__internals.CEK_INFO), RFC8291.cekInfo, 'cek_info 对不上');
  assert.equal(encodeBase64Url(__internals.NONCE_INFO), RFC8291.nonceInfo, 'nonce_info 对不上');
});

test('RFC 8291 Appendix A：86 字节的头部和密文部分分别对得上', () => {
  const out = encryptPayload({
    p256dh: RFC8291.uaPublic,
    auth: RFC8291.authSecret,
    plaintext: RFC8291.plaintext,
    salt: b64(RFC8291.salt),
    senderPrivateKey: b64(RFC8291.asPrivate),
  });

  const header = out.subarray(0, 86);
  const ciphertext = out.subarray(86);
  assert.equal(encodeBase64Url(header), RFC8291.header, '86 字节头部对不上');
  assert.equal(encodeBase64Url(ciphertext), RFC8291.ciphertextOnly, '密文部分对不上');

  // 头部的字段拆开看：salt(16) || rs(4) || idlen(1) || keyid(65)
  assert.equal(encodeBase64Url(header.subarray(0, 16)), RFC8291.salt);
  assert.equal(header.readUInt32BE(16), 4096, '记录大小必须是 4096，换个数字向量就对不上了');
  assert.equal(header[20], 65, 'keyid 长度必须是 65');
  assert.equal(encodeBase64Url(header.subarray(21)), RFC8291.asPublic);
});

/** 接收端的解密：完全按 RFC 8291 反着做一遍，用来验证随机路径（不是注入固定值那条）。 */
function decryptAsUserAgent({ body, uaPrivate, authSecret }) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(asPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  assert.equal(padded[padded.length - 1], 0x02, 'padding 分隔符必须是 0x02（最后一条记录）');
  return padded.subarray(0, padded.length - 1).toString('utf8');
}

test('生产路径（随机 salt + 随机发送方密钥）产出的密文，接收端能解开', () => {
  // 用 RFC 的接收方密钥对，但让 encryptPayload 走随机路径。
  const message = '有人在「产品组」提到了你：明天的评审改到十点';
  const out = encryptPayload({ p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret, plaintext: message });

  assert.notEqual(encodeBase64Url(out.subarray(0, 16)), RFC8291.salt, 'salt 必须是随机的，不能写死');
  assert.equal(
    decryptAsUserAgent({ body: out, uaPrivate: b64(RFC8291.uaPrivate), authSecret: b64(RFC8291.authSecret) }),
    message,
  );

  // 每次调用的 salt 和临时公钥都必须**分别**不同，否则等于复用 nonce。
  // 这里必须逐段比，不能只比整条密文：salt 写死、只有临时密钥随机时，
  // 整条密文照样每次都不一样，一条「整体不相等」的断言是抓不到的。
  const again = encryptPayload({ p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret, plaintext: message });
  assert.notEqual(encodeBase64Url(out.subarray(0, 16)), encodeBase64Url(again.subarray(0, 16)), 'salt 必须每次重新随机');
  assert.notEqual(encodeBase64Url(out.subarray(21, 86)), encodeBase64Url(again.subarray(21, 86)), '临时公钥必须每次重新生成');
  assert.equal(
    decryptAsUserAgent({ body: again, uaPrivate: b64(RFC8291.uaPrivate), authSecret: b64(RFC8291.authSecret) }),
    message,
  );
});

test('encryptPayload 对坏输入直接报错，不产出「能发出去但解不开」的东西', () => {
  const ok = { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret, plaintext: 'hi' };
  assert.throws(() => encryptPayload({ ...ok, p256dh: 'not-base64url!!' }), /p256dh/);
  assert.throws(() => encryptPayload({ ...ok, p256dh: encodeBase64Url(Buffer.alloc(64)) }), /p256dh/);
  // 长度对但不是未压缩公钥（首字节不是 0x04）
  assert.throws(() => encryptPayload({ ...ok, p256dh: encodeBase64Url(Buffer.alloc(65, 3)) }), /p256dh/);
  // 首字节是 0x04、长度也对，但那个点不在曲线上：报错要说人话，不是 crypto 的原始英文
  const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]);
  assert.throws(() => encryptPayload({ ...ok, p256dh: encodeBase64Url(offCurve) }), /P-256 曲线上的有效公钥点/);
  assert.throws(() => encryptPayload({ ...ok, auth: encodeBase64Url(Buffer.alloc(8)) }), /auth/);
  assert.throws(
    () => encryptPayload({ ...ok, plaintext: 'x'.repeat(__internals.MAX_PLAINTEXT_LENGTH + 1) }),
    /正文过长/,
  );
  // 刚好到上限要能过
  assert.doesNotThrow(() => encryptPayload({ ...ok, plaintext: 'x'.repeat(__internals.MAX_PLAINTEXT_LENGTH) }));
});

// ───────────────────────────────────────────────────────────────────────
// RFC 8292 §2.4 的 VAPID 例子
// ───────────────────────────────────────────────────────────────────────
const RFC8292 = {
  endpoint: 'https://push.example.net/p/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
  audience: 'https://push.example.net',
  subject: 'mailto:push@example.com',
  exp: 1453523768,
  jwt:
    'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.' +
    'eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.' +
    'i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA',
  publicKey: 'BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs',
};

/** 从 base64url 的 65 字节未压缩公钥造一个可以验签的 KeyObject。 */
function publicKeyObject(publicKeyB64) {
  const raw = b64(publicKeyB64);
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: encodeBase64Url(raw.subarray(1, 33)),
      y: encodeBase64Url(raw.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

test('RFC 8292 §2.4：规范给的那个 JWT 用规范给的那个公钥能验过', () => {
  // 这条不测我们的代码，测的是「我们理解的 ES256 验签方式（JOSE 的 r||s，不是 DER）
  // 和规范一致」。下面几条自验用例全都建立在这个前提上。
  const [header, payload, signature] = RFC8292.jwt.split('.');
  const ok = cryptoVerify(
    'sha256',
    Buffer.from(`${header}.${payload}`),
    { key: publicKeyObject(RFC8292.publicKey), dsaEncoding: 'ieee-p1363' },
    b64(signature),
  );
  assert.equal(ok, true, 'RFC 8292 §2.4 的例子自己都验不过，说明验签方式理解错了');
  assert.deepEqual(JSON.parse(b64(payload).toString()), {
    aud: RFC8292.audience,
    exp: RFC8292.exp,
    sub: RFC8292.subject,
  });
});

test('RFC 8292 §2.4：同样的输入，我们签出来的 payload 段与规范逐字节相同', (t) => {
  // 把时钟拨到「规范那个 exp 减去默认有效期」的时刻，exp 就正好落在 1453523768。
  const expiresIn = 12 * 60 * 60;
  t.mock.timers.enable({ apis: ['Date'], now: (RFC8292.exp - expiresIn) * 1000 });

  const { publicKey, privateKey } = freshVapidKeys();
  const { Authorization } = vapidHeaders({
    endpoint: RFC8292.endpoint,
    subject: RFC8292.subject,
    publicKey,
    privateKey,
  });

  const token = Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(token, `Authorization 头格式不对：${Authorization}`);
  const [, ourJwt, k] = token;
  const [ourHeaderSeg, ourPayloadSeg] = ourJwt.split('.');

  const rfcPayloadSeg = RFC8292.jwt.split('.')[1];
  assert.equal(ourPayloadSeg, rfcPayloadSeg, 'JWT payload 段与 RFC 8292 §2.4 的例子对不上');

  // header 段不做字节比对：RFC 的例子是 {"typ","alg"} 的顺序，jsonwebtoken 出的是
  // {"alg","typ"}。JSON 键序不是规范要求，所以这里比内容不比字节。
  assert.deepEqual(JSON.parse(b64(ourHeaderSeg).toString()), { alg: 'ES256', typ: 'JWT' });
  assert.equal(k, publicKey, 'k 参数必须是我们的 VAPID 公钥原样');
});

/** 现造一对 VAPID 密钥（base64url 的 65 字节公钥 / 32 字节私钥）。 */
function freshVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    publicKey: encodeBase64Url(Buffer.concat([Buffer.from([0x04]), b64(jwk.x), b64(jwk.y)])),
    privateKey: jwk.d,
    publicKeyObject: publicKey,
  };
}

test('VAPID JWT：签名能被独立验过，aud 是 endpoint 的 origin，exp 在 24 小时内', () => {
  const keys = freshVapidKeys();
  const endpoint = 'https://web.push.apple.com/QABC123/very/long/path?x=1';
  const before = Math.floor(Date.now() / 1000);

  const headers = vapidHeaders({ endpoint, subject: 'mailto:ops@example.com', ...keys });
  const [, token, k] = headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);

  // 真的验一遍签名（不是「有三段就算过」）：拿 k 里的公钥去验。
  const claims = jwt.verify(token, publicKeyObject(k), { algorithms: ['ES256'] });

  assert.equal(claims.aud, 'https://web.push.apple.com', 'aud 必须是 endpoint 的 origin，不是我们自己的域名');
  assert.equal(claims.sub, 'mailto:ops@example.com');
  assert.equal(claims.iat, undefined, 'RFC 8292 只要 aud/exp/sub，不该多一个 iat');
  assert.ok(claims.exp > before, 'exp 必须在将来');
  assert.ok(claims.exp <= before + __internals.JWT_MAX_TTL_SECONDS, 'exp 不得超过请求时刻之后 24 小时');
  assert.equal(k, keys.publicKey);

  // 换一个 endpoint，aud 必须跟着变——JWT 不能签一次到处用。
  const other = vapidHeaders({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', subject: 'mailto:ops@example.com', ...keys });
  const otherToken = other.Authorization.match(/^vapid t=([^,]+),/)[1];
  assert.equal(jwt.verify(otherToken, publicKeyObject(keys.publicKey)).aud, 'https://fcm.googleapis.com');
});

test('VAPID JWT：换过的公钥验不过（证明上一条不是在自欺欺人）', () => {
  const keys = freshVapidKeys();
  const stranger = freshVapidKeys();
  const headers = vapidHeaders({ endpoint: 'https://push.example.net/p/x', subject: 'mailto:ops@example.com', ...keys });
  const token = headers.Authorization.match(/^vapid t=([^,]+),/)[1];
  assert.throws(() => jwt.verify(token, publicKeyObject(stranger.publicKey), { algorithms: ['ES256'] }), /signature/i);
});

test('VAPID JWT：有效期超过 24 小时直接拒绝', () => {
  const keys = freshVapidKeys();
  const args = { endpoint: 'https://push.example.net/p/x', subject: 'mailto:ops@example.com', ...keys };
  assert.throws(() => vapidHeaders({ ...args, expiresIn: 24 * 60 * 60 + 1 }), /24 小时/);
  assert.throws(() => vapidHeaders({ ...args, expiresIn: 0 }), /24 小时/);
  assert.doesNotThrow(() => vapidHeaders({ ...args, expiresIn: 24 * 60 * 60 }));
});

test('vapidHeaders：endpoint 必须是合法的 https URL', () => {
  const keys = freshVapidKeys();
  for (const endpoint of ['', 'not a url', 'http://push.example.net/p/x', undefined]) {
    assert.throws(
      () => vapidHeaders({ endpoint, subject: 'mailto:ops@example.com', ...keys }),
      /endpoint/,
      `endpoint=${String(endpoint)} 应该被拒`,
    );
  }
});

// ───────────────────────────────────────────────────────────────────────
// Apple 对 sub 的严格校验
// ───────────────────────────────────────────────────────────────────────

test('subject 是 mailto:x@localhost 时在本模块内就报错（Apple 会 403 BadJwtToken）', () => {
  const check = validateVapidSubject('mailto:x@localhost');
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'subject_not_routable');
  // 报错要说人话，还要点名苹果——不然运维看到 403 也不知道是这儿的问题。
  assert.match(check.message, /403 BadJwtToken/);
  assert.match(check.message, /localhost/);

  // 而且要在签 JWT 那一步就炸，不能等打到苹果才发现。
  const keys = freshVapidKeys();
  assert.throws(
    () => vapidHeaders({ endpoint: 'https://web.push.apple.com/p/x', subject: 'mailto:x@localhost', ...keys }),
    /403 BadJwtToken/,
  );
});

test('validateVapidSubject：不可路由的域名一律 subject_not_routable', () => {
  const notRoutable = [
    'mailto:x@localhost',
    'mailto:x@LOCALHOST',
    'mailto:x@dev.local',
    'mailto:x@box.internal',
    'mailto:x@intranet',            // 没有点的内网短名
    'mailto:x@192.168.1.10',
    'https://localhost/contact',
    'https://loop-im.local/contact',
    'https://127.0.0.1:8443/contact',
    'https://[::1]/contact',
  ];
  for (const subject of notRoutable) {
    const check = validateVapidSubject(subject);
    assert.equal(check.ok, false, `${subject} 应该被判为不可路由`);
    assert.equal(check.reason, 'subject_not_routable', `${subject} 的 reason 不对`);
  }
});

test('validateVapidSubject：格式不对是 invalid_subject，合法的要放行', () => {
  for (const subject of ['', '   ', undefined, null, 'admin@example.com', 'http://example.com', 'tel:+8613800138000', 'mailto:example.com', 'mailto:@example.com', 'mailto:x@']) {
    const check = validateVapidSubject(subject);
    assert.equal(check.ok, false, `${String(subject)} 应该被拒`);
    assert.equal(check.reason, 'invalid_subject', `${String(subject)} 的 reason 不对`);
  }
  for (const subject of ['mailto:admin@example.com', 'https://loop-im.example.com/', 'https://example.co.uk/about', ' mailto:admin@example.com ']) {
    assert.deepEqual(validateVapidSubject(subject), { ok: true }, `${subject} 应该放行`);
  }
});

test('validateVapidKeys：长度、曲线点、以及公私钥是不是一对', () => {
  const keys = freshVapidKeys();
  assert.deepEqual(validateVapidKeys(keys), { ok: true });

  const bad = [
    { publicKey: 'nope!!', privateKey: keys.privateKey },
    { publicKey: encodeBase64Url(Buffer.alloc(64)), privateKey: keys.privateKey },
    { publicKey: encodeBase64Url(Buffer.alloc(65, 9)), privateKey: keys.privateKey },  // 首字节不是 0x04
    { publicKey: keys.publicKey, privateKey: encodeBase64Url(Buffer.alloc(31)) },
    { publicKey: keys.publicKey, privateKey: '' },
    // 长度都对，但不是一对——这种最阴，签得出来、推送服务验不过
    { publicKey: keys.publicKey, privateKey: freshVapidKeys().privateKey },
  ];
  for (const args of bad) {
    const check = validateVapidKeys(args);
    assert.equal(check.ok, false, `${JSON.stringify(args).slice(0, 60)} 应该被拒`);
    assert.equal(check.reason, 'invalid_key');
  }
  assert.match(
    validateVapidKeys({ publicKey: keys.publicKey, privateKey: freshVapidKeys().privateKey }).message,
    /不是一对/,
  );
});

// ───────────────────────────────────────────────────────────────────────
// sendPush 与错误分类
// ───────────────────────────────────────────────────────────────────────

const SUBSCRIPTION = {
  endpoint: 'https://web.push.apple.com/QABC123/token',
  keys: { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
};

function stubFetch(status, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    if (status instanceof Error) throw status;
    return { status, ok: status >= 200 && status < 300 };
  };
}

test('sendPush：404 / 410 是订阅失效，调用方必须删', async () => {
  const keys = freshVapidKeys();
  const vapid = { subject: 'mailto:ops@example.com', publicKey: keys.publicKey, privateKey: keys.privateKey };
  for (const status of [404, 410]) {
    const res = await sendPush({ subscription: SUBSCRIPTION, payload: '新消息', vapid, fetchImpl: stubFetch(status) });
    assert.deepEqual(res, { ok: false, status, gone: true }, `${status} 应该是 gone`);
  }
});

test('sendPush：其它错误都是临时失败，删订阅会误伤', async () => {
  const keys = freshVapidKeys();
  const vapid = { subject: 'mailto:ops@example.com', publicKey: keys.publicKey, privateKey: keys.privateKey };
  // 401/403 是我们自己配错了，429 是限流，5xx 是对方抽风 —— 一条都不该删订阅。
  for (const status of [400, 401, 403, 413, 429, 500, 502, 503]) {
    const res = await sendPush({ subscription: SUBSCRIPTION, payload: '新消息', vapid, fetchImpl: stubFetch(status) });
    assert.deepEqual(res, { ok: false, status, gone: false }, `${status} 不该被判成 gone`);
  }
  // 网络层根本没通：status 0，同样不删。
  const netFail = await sendPush({
    subscription: SUBSCRIPTION,
    payload: '新消息',
    vapid,
    fetchImpl: stubFetch(new Error('ECONNRESET')),
  });
  assert.deepEqual(netFail, { ok: false, status: 0, gone: false });
});

test('sendPush：2xx 是成功', async () => {
  const keys = freshVapidKeys();
  const vapid = { subject: 'mailto:ops@example.com', publicKey: keys.publicKey, privateKey: keys.privateKey };
  for (const status of [200, 201, 202]) {
    const res = await sendPush({ subscription: SUBSCRIPTION, payload: '新消息', vapid, fetchImpl: stubFetch(status) });
    assert.deepEqual(res, { ok: true, status, gone: false });
  }
});

test('sendPush：请求头和请求体都对，且正文真的能被订阅方解开', async () => {
  const keys = freshVapidKeys();
  const vapid = { subject: 'mailto:ops@example.com', publicKey: keys.publicKey, privateKey: keys.privateKey };
  const calls = [];
  const message = '「产品组」有 3 条新消息';

  const res = await sendPush({
    subscription: SUBSCRIPTION,
    payload: message,
    ttl: 3600,
    vapid,
    fetchImpl: stubFetch(201, calls),
  });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);

  const { url, init } = calls[0];
  assert.equal(url, SUBSCRIPTION.endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers.TTL, '3600');
  assert.equal(init.headers.Urgency, 'normal');
  assert.match(init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);

  // 最关键的一条：请求体是不是订阅方真的能解开的东西。
  assert.equal(
    decryptAsUserAgent({ body: init.body, uaPrivate: b64(RFC8291.uaPrivate), authSecret: b64(RFC8291.authSecret) }),
    message,
  );
});

test('sendPush：配置或订阅数据有问题时不发请求，也绝不判成 gone', async () => {
  const keys = freshVapidKeys();
  const good = { subject: 'mailto:ops@example.com', publicKey: keys.publicKey, privateKey: keys.privateKey };
  const cases = [
    // subject 会被苹果 403 —— 这时候删订阅是把用户的订阅白删了
    { subscription: SUBSCRIPTION, vapid: { ...good, subject: 'mailto:x@localhost' } },
    { subscription: SUBSCRIPTION, vapid: { ...good, publicKey: 'broken' } },
    { subscription: { ...SUBSCRIPTION, endpoint: 'http://insecure.example/p' }, vapid: good },
    { subscription: { endpoint: SUBSCRIPTION.endpoint, keys: { p256dh: 'bad', auth: RFC8291.authSecret } }, vapid: good },
    { subscription: { endpoint: SUBSCRIPTION.endpoint, keys: { p256dh: RFC8291.uaPublic, auth: 'bad' } }, vapid: good },
  ];
  for (const { subscription, vapid } of cases) {
    const calls = [];
    const res = await sendPush({ subscription, payload: 'x', vapid, fetchImpl: stubFetch(201, calls) });
    assert.deepEqual(res, { ok: false, status: 0, gone: false });
    assert.equal(calls.length, 0, '不该把一个注定失败的请求真发出去');
  }
});

test('sendPush：订阅的 keys 写成扁平字段也认（2B 从库里读出来就是扁平的）', async () => {
  const keys = freshVapidKeys();
  const vapid = { subject: 'mailto:ops@example.com', publicKey: keys.publicKey, privateKey: keys.privateKey };
  const calls = [];
  const res = await sendPush({
    subscription: { endpoint: SUBSCRIPTION.endpoint, p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
    payload: 'x',
    vapid,
    fetchImpl: stubFetch(201, calls),
  });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
});

test('isGoneStatus：只有 404 和 410', () => {
  assert.equal(isGoneStatus(404), true);
  assert.equal(isGoneStatus(410), true);
  for (const status of [0, 200, 201, 400, 401, 403, 408, 409, 429, 500, 503]) {
    assert.equal(isGoneStatus(status), false, `${status} 不该是 gone`);
  }
});

test('decodeBase64Url：非法输入返回 null，不静默吞掉坏字符', () => {
  // Node 的 Buffer.from(x,'base64url') 会静默丢弃非法字符，
  // 2B 要靠这个函数判「订阅里的 key 格式对不对」，不能被它糊弄过去。
  assert.equal(decodeBase64Url('!!!!'), null);
  assert.equal(decodeBase64Url('ab cd'), null);
  assert.equal(decodeBase64Url('a+b/c'), null, 'base64（非 url 变体）不算合法');
  assert.equal(decodeBase64Url(''), null);
  assert.equal(decodeBase64Url(null), null);
  assert.equal(decodeBase64Url(123), null);
  assert.equal(decodeBase64Url(RFC8291.authSecret).length, 16);
  assert.equal(decodeBase64Url(RFC8291.uaPublic).length, 65);
  assert.equal(encodeBase64Url(decodeBase64Url(RFC8291.uaPublic)), RFC8291.uaPublic);
});
