import './helpers.js';
// issue #6：主动退出登录后，其他成员仍然看到其在线（要等 90 秒心跳窗口过期）。
import { startServer } from './helpers.js';
import { member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, lin;
const openStreams = new Set();

before(async () => {
  api = await startServer();
  lin = await member('林小满', { dept: '运营' });
});
after(async () => {
  for (const stream of [...openStreams]) stream.close();
  await api.close();
});

/** 极简 SSE 客户端：把收到的事件按顺序堆进数组，供断言使用。 */
async function openStream(token) {
  const controller = new AbortController();
  const res = await fetch(`${api.baseUrl}/api/stream?token=${encodeURIComponent(token)}`, {
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const lines = buffer.slice(0, cut).split('\n');
          buffer = buffer.slice(cut + 2);
          const name = lines.find((l) => l.startsWith('event: '));
          const data = lines.find((l) => l.startsWith('data: '));
          if (name && data) events.push({ event: name.slice(7), data: JSON.parse(data.slice(6)) });
        }
      }
    } catch { /* 连接被 abort，正常结束 */ }
  })();
  const stream = { events, close: () => { controller.abort(); openStreams.delete(stream); } };
  openStreams.add(stream);
  return stream;
}

const onlineOf = async (token, userId) => {
  const res = await api.get('/api/users', token);
  assert.equal(res.status, 200);
  return res.body.users.find((u) => u.id === userId)?.online;
};

const waitForPresence = (stream, userId, online) => new Promise((resolve) => {
  const hit = () => stream.events.find(
    (e) => e.event === 'presence' && e.data.userId === userId && e.data.online === online,
  );
  const timer = setInterval(() => {
    const found = hit();
    if (found) { clearInterval(timer); clearTimeout(bail); resolve(found); }
  }, 30);
  const bail = setTimeout(() => { clearInterval(timer); resolve(null); }, 3000);
});

describe('主动退出登录（issue #6）', () => {
  it('退出后其他人立刻看到离线，并收到 presence 广播', async () => {
    const adminToken = await api.loginAdmin();
    const adminStream = await openStream(adminToken);
    const token = await api.login(lin.email);
    assert.equal(await onlineOf(adminToken, lin.id), true);

    const res = await api.post('/api/auth/logout', {}, token);
    assert.equal(res.status, 200);
    assert.equal(await onlineOf(adminToken, lin.id), false);
    assert.ok(await waitForPresence(adminStream, lin.id, false), '管理员应当收到该成员的 presence offline 广播');
    adminStream.close();
  });

  it('退出后原来的 token 不能再用', async () => {
    const token = await api.login(lin.email);
    assert.equal((await api.post('/api/auth/logout', {}, token)).status, 200);
    assert.equal((await api.get('/api/auth/me', token)).status, 401);
  });

  it('同账号多端在线时，退出一端不会把另一端也标成离线', async () => {
    const adminToken = await api.loginAdmin();
    const phone = await api.login(lin.email);
    const laptop = await api.login(lin.email);

    assert.equal((await api.post('/api/auth/logout', {}, phone)).status, 200);
    assert.equal(await onlineOf(adminToken, lin.id), true, '另一端仍在线时不应显示离线');
    assert.equal((await api.get('/api/auth/me', laptop)).status, 200, '另一端的 token 应当仍然有效');

    assert.equal((await api.post('/api/auth/logout', {}, laptop)).status, 200);
    assert.equal(await onlineOf(adminToken, lin.id), false);
  });

  it('重新登录后立刻恢复在线', async () => {
    const adminToken = await api.loginAdmin();
    const token = await api.login(lin.email);
    await api.post('/api/auth/logout', {}, token);
    assert.equal(await onlineOf(adminToken, lin.id), false);

    await api.login(lin.email);
    assert.equal(await onlineOf(adminToken, lin.id), true);
  });
});
