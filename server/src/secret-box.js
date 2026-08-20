// AI 供应商的 API Key 要落库，明文存 SQLite 意味着拿到 data/ 目录就拿到 Key。
// 这里用 Node 内置 crypto 做 AES-256-GCM 加密，不引第三方依赖。
//
// 兼容性是硬要求：现有部署的库里存的是明文，且不一定配了 ENCRYPTION_KEY。
// 所以 decrypt() 遇到没有前缀的值一律当明文返回，encrypt() 在没配密钥时原样返回。
// 缺密钥只降级、不报错，绝不能让已经在跑的实例起不来。
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const PREFIX = 'v1';
const ALGO = 'aes-256-gcm';

/** 32 字节密钥：优先按 64 位十六进制直接解析，否则把任意字符串用 scrypt 派生。 */
function resolveKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  // 固定 salt：这里的目的是把任意口令拉伸成定长密钥，不是存储口令哈希。
  return scryptSync(raw, 'loop-im-secret-box', 32);
}

const key = resolveKey();

export const isEncryptionConfigured = () => key !== null;

/** 已经加密过的值长这样：v1:<iv>:<authTag>:<密文>，都是 base64。 */
export const isEncrypted = (value) => typeof value === 'string' && value.startsWith(`${PREFIX}:`);

export function encrypt(plain) {
  if (!key || !plain) return plain;          // 没配密钥就退回明文（启动时已告警）
  if (isEncrypted(plain)) return plain;      // 幂等：别把密文再加一层
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(stored) {
  if (!isEncrypted(stored)) return stored;   // 老库里的明文
  if (!key) {
    // 库里是密文却没给密钥：这时候拿不回原值，当作未配置凭据处理，
    // 好过抛异常让整个 AI 模块不可用。
    return '';
  }
  try {
    const [, iv, tag, ct] = stored.split(':');
    const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';                               // 密钥换过、密文被改坏：同样降级
  }
}
