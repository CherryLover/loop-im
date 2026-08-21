// 手写的 AWS Signature V4（server/src/s3-sign.js）对不对，只能靠向量证明 ——
// 测试里没有真实的 MinIO，签错了只会在部署那天以 403 SignatureDoesNotMatch 的形式炸出来。
//
// 下面两条是 AWS 官方文档「Signature Calculations for the Authorization Header」
// 里给出的示例请求与期望签名，密钥也是文档里那对公开的示例密钥（不是任何真实凭据）。
import './helpers.js';
import { encodeS3Path, signS3Request } from '../src/s3-sign.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// AWS 文档里的示例凭据，全世界的 SigV4 实现都拿它对答案。
const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const DATE = new Date('2013-05-24T00:00:00Z');

describe('S3 签名 · AWS 官方向量', () => {
  it('GET Object（带 Range 头）的签名和文档一致', () => {
    const { signature } = signS3Request({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      headers: { range: 'bytes=0-9' },
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      region: 'us-east-1',
      date: DATE,
    });
    assert.equal(signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('PUT Object（带载荷）的签名和文档一致', () => {
    const { signature, canonicalRequest } = signS3Request({
      method: 'PUT',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test$file.text',
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      payload: Buffer.from('Welcome to Amazon S3.'),
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      region: 'us-east-1',
      date: DATE,
    });
    assert.equal(signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
    // 顺带钉住规范请求里最容易写错的一处：`$` 必须被编码成 %24。
    assert.match(canonicalRequest, /^PUT\n\/test%24file\.text\n/);
  });
});

describe('S3 签名 · 细节', () => {
  it('路径按 RFC3986 编码，斜杠保持原样', () => {
    // encodeURIComponent 会放过这几个字符，规范路径不允许。
    assert.equal(encodeS3Path("/bucket/a!b'c(d)e*f$g"), '/bucket/a%21b%27c%28d%29e%2Af%24g');
    assert.equal(encodeS3Path('/bucket/9f3a-1b.png'), '/bucket/9f3a-1b.png');
    assert.equal(encodeS3Path('/bucket/交付物.bin'), '/bucket/%E4%BA%A4%E4%BB%98%E7%89%A9.bin');
  });

  it('必带的三个头都在 SignedHeaders 里，且 Authorization 形如规范所写', () => {
    const { headers } = signS3Request({
      method: 'DELETE',
      host: 'minio:9000',
      path: '/loop-im/9f3a.bin',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      region: 'us-east-1',
      date: DATE,
    });
    assert.equal(headers['x-amz-date'], '20130524T000000Z');
    // 空载荷的 SHA-256。
    assert.equal(headers['x-amz-content-sha256'],
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.match(headers.Authorization,
      /^AWS4-HMAC-SHA256 Credential=minioadmin\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });

  it('换一个密钥就换一个签名（别把 secret 漏掉不参与计算）', () => {
    const base = {
      method: 'GET', host: 'minio:9000', path: '/loop-im/a.png',
      accessKeyId: 'k', region: 'us-east-1', date: DATE,
    };
    const a = signS3Request({ ...base, secretAccessKey: 'one' }).signature;
    const b = signS3Request({ ...base, secretAccessKey: 'two' }).signature;
    assert.notEqual(a, b);
  });
});
