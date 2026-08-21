import './helpers.js';
import { __redactForTest, logEvent, logWarn, logError } from '../src/log.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('结构化日志', () => {
  it('敏感字段一律隐去 —— 这是红线，不是建议', () => {
    const out = __redactForTest({
      userId: 'u_1',
      password: 'hunter2',
      passwordHash: '$2b$10$abc',
      token: 'eyJhbGciOi...',
      api_key: 'sk-live-xxx',
      Authorization: 'Bearer xxx',
      body: '这是一条不该进日志的消息正文',
    });
    assert.equal(out.userId, 'u_1', '非敏感字段要照常记录');
    for (const key of ['password', 'passwordHash', 'token', 'api_key', 'Authorization', 'body']) {
      assert.equal(out[key], '[已隐去]', `${key} 泄漏了`);
    }
  });

  it('字段名的大小写、下划线、驼峰都拦得住', () => {
    const out = __redactForTest({ API_KEY: 'x', apiKey: 'x', 'access-token': 'x', PASSWORD: 'x' });
    for (const [key, value] of Object.entries(out)) {
      assert.equal(value, '[已隐去]', `${key} 没拦住`);
    }
  });

  it('嵌套对象里的敏感字段同样隐去', () => {
    const out = __redactForTest({ user: { id: 'u_1', password: 'hunter2' } });
    assert.equal(out.user.id, 'u_1');
    assert.equal(out.user.password, '[已隐去]');
  });

  it('超长字符串被截断，日志不当数据库用', () => {
    const out = __redactForTest({ note: 'x'.repeat(500) });
    assert.ok(out.note.length < 250, '没截断');
    assert.match(out.note, /共500字/);
  });

  it('Error 被压成 name + message，不整个塞进去', () => {
    const out = __redactForTest({ err: new TypeError('炸了') });
    assert.deepEqual(out.err, { name: 'TypeError', message: '炸了' });
  });

  it('测试环境默认不打印，免得淹掉真正的失败信息', () => {
    const lines = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (l) => lines.push(l);
    console.error = (l) => lines.push(l);
    try {
      logEvent('probe', { a: 1 });
      logWarn('probe', { a: 1 });
      logError('probe', new Error('x'));
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    assert.equal(lines.length, 0, `测试环境不该打印，却打了 ${lines.length} 行`);
  });

  it('打开 LOG_IN_TEST 后是一行合法 JSON，字段齐全', () => {
    const lines = [];
    const orig = console.log;
    console.log = (l) => lines.push(l);
    process.env.LOG_IN_TEST = '1';
    try {
      logEvent('message.sent', { userId: 'u_1', conversationId: 'c_1', bytes: 42 });
    } finally {
      console.log = orig;
      delete process.env.LOG_IN_TEST;
    }
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.level, 'info');
    assert.equal(row.event, 'message.sent');
    assert.equal(row.userId, 'u_1');
    assert.equal(row.bytes, 42);
    assert.ok(!Number.isNaN(Date.parse(row.ts)), 'ts 不是合法时间');
  });
});
