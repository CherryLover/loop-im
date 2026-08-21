/**
 * AWS Signature V4 —— 只够用来对单个对象做 PUT / GET / DELETE。
 *
 * 为什么手写而不是引 @aws-sdk/client-s3 或 minio：
 * 本仓库的服务端依赖一共只有 5 个（express / cors / multer / jsonwebtoken / bcryptjs），
 * secret-box.js 也已经立过「用 node 内置 crypto，不引第三方」的先例。
 * 我们要的只是「往内网 MinIO 放一个对象、取回来、删掉」这三件事，不需要分片上传、
 * 不需要预签名、不需要 STS、不需要重试策略——@aws-sdk/client-s3 会为此拖进几十个
 * 传递依赖（以及一套自己的 HTTP 栈），minio 也有它自己的一串依赖。
 * Node 22 自带 fetch 和 crypto，签名本身就是下面这 40 行。
 *
 * 代价说清楚：签名算法没有被真实的 MinIO 覆盖（测试里跑的是内存实现），
 * 只有本文件的向量用例在锁它。见 test/s3-sign.test.js。
 */
import { createHash, createHmac } from 'node:crypto';

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * RFC 3986 的「未保留字符」之外全部百分号编码。
 * 不能用 encodeURIComponent：它放过 ! ' ( ) * $ 这几个，而 S3 的规范路径要求它们也编码
 * （AWS 自己的示例里 `/test$file.text` 的规范形式就是 `/test%24file.text`）。
 * 按码点而不是按 UTF-16 单元遍历，免得把代理对拆成两半。
 */
const encodeSegment = (segment) =>
  Array.from(String(segment))
    .map((ch) =>
      /^[A-Za-z0-9\-_.~]$/.test(ch)
        ? ch
        : Array.from(Buffer.from(ch, 'utf8'))
            .map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`)
            .join(''))
    .join('');

/** 路径按 `/` 切开逐段编码：斜杠本身在规范 URI 里保持原样。 */
export const encodeS3Path = (path) => String(path).split('/').map(encodeSegment).join('/');

const amzDate = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * 算出 Authorization 头。返回值里包含最终要发出去的全部头，调用方直接塞给 fetch。
 *
 * @param headers 额外的头（如 content-type）。host / x-amz-date / x-amz-content-sha256
 *                由本函数补齐，调用方不要自己写。
 */
export function signS3Request({
  method,
  host,
  path,
  query = '',
  headers = {},
  payload = Buffer.alloc(0),
  accessKeyId,
  secretAccessKey,
  region = 'us-east-1',
  service = 's3',
  date = new Date(),
}) {
  const stamp = amzDate(date);
  const day = stamp.slice(0, 8);
  const payloadHash = sha256hex(payload);

  const signed = {
    ...Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined && v !== null)),
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
  };
  // 规范头：键小写、值 trim、按键名排序。
  const canonicalEntries = Object.entries(signed)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = canonicalEntries.map(([k]) => k).join(';');
  const canonicalHeaders = canonicalEntries.map(([k, v]) => `${k}:${v}\n`).join('');

  const canonicalRequest = [
    method,
    encodeS3Path(path),
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(canonicalRequest)].join('\n');

  let key = hmac(`AWS4${secretAccessKey}`, day);
  for (const part of [region, service, 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

  return {
    signature,
    canonicalRequest,
    stringToSign,
    headers: {
      ...signed,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}
