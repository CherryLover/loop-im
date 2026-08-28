/**
 * 附件下载鉴权：只有**该附件所在会话的成员**才能下载。
 *
 * 改造之前 /uploads 是完全公开的 —— 拿到 URL（或者猜到 key）就能下载，不用登录。
 * 「某个对象属于哪个会话」这条关联以前根本不存在，现在记在 attachment_refs 里：
 * 消息落库时由 linkAttachmentsToMessage 写入，历史数据由 db.js 的一次性回填补上。
 *
 * 拒绝一律用同一个状态码 + 同一句话，否则接口就成了「这个附件存不存在」的探针。
 */
import { startServer } from './helpers.js';
import { direct, group, member } from './fixtures.js';
import { PNG } from './samples.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, adminToken, chen, zhou, lin, chenToken, zhouToken, linToken, roomA, roomB;

const uploadAs = async (token, buffer = PNG) => {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/png' }), 'shot.png');
  const res = await api.call('POST', '/api/uploads', { token, form });
  assert.equal(res.status, 201);
  return res.body.url;
};

const send = (id, body, token) => api.post(`/api/conversations/${id}/messages`, { body }, token);

/** 带凭据去取附件。token 传 null 就是不带（模拟未登录）。 */
const fetchAs = (url, token) =>
  fetch(`${api.baseUrl}${url}${token ? `?token=${encodeURIComponent(token)}` : ''}`);

/** 一次断言「被拒了，而且拒得和查无此物一模一样」。 */
async function assertDenied(res) {
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, '附件不存在');
}

before(async () => {
  api = await startServer();
  adminToken = await api.loginAdmin();
  chen = await member('陈子航', { dept: '后端' });
  zhou = await member('周明', { dept: '前端' });
  lin = await member('林悦', { dept: '设计' });
  chenToken = await api.login(chen.email);
  zhouToken = await api.login(zhou.email);
  linToken = await api.login(lin.email);
  roomA = await group(api, adminToken, '附件鉴权 · A 群', [chen.id, zhou.id]);
  roomB = await group(api, adminToken, '附件鉴权 · B 群', [lin.id]);
});
after(async () => { await api.close(); });

describe('附件下载 · 未登录', () => {
  it('不带凭据一律 401，连附件在不在都不告诉它', async () => {
    const url = await uploadAs(chenToken);
    await send(roomA.id, `![截图](${url})`, chenToken);
    const res = await fetchAs(url, null);
    assert.equal(res.status, 401);
  });

  it('伪造的 token 也是 401', async () => {
    const url = await uploadAs(chenToken);
    await send(roomA.id, `![截图](${url})`, chenToken);
    assert.equal((await fetchAs(url, 'not-a-real-token')).status, 401);
  });
});

describe('附件下载 · 会话成员', () => {
  it('同一个群里的其他人能下载', async () => {
    const url = await uploadAs(chenToken);
    await send(roomA.id, `![截图](${url})`, chenToken);
    const res = await fetchAs(url, zhouToken);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  });

  it('不在这个群里的人下载不到，提示和「查无此附件」完全一致', async () => {
    const url = await uploadAs(chenToken);
    await send(roomA.id, `![截图](${url})`, chenToken);
    await assertDenied(await fetchAs(url, linToken));

    // 逐字比对：一个根本不存在的 key 给的是同一句话，所以这个接口不是存在性探针。
    const ghost = await fetchAs('/uploads/00000000-0000-4000-8000-000000000000.png', linToken);
    const denied = await fetchAs(url, linToken);
    assert.equal(ghost.status, denied.status);
    assert.equal((await ghost.json()).error, (await denied.json()).error);
  });

  it('非图片附件（.bin）走同一套判定', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('机密报表')], { type: 'text/plain' }), 'q3.txt');
    const { body } = await api.call('POST', '/api/uploads', { token: chenToken, form });
    await send(roomA.id, `[q3.txt](${body.url})`, chenToken);

    assert.equal((await fetchAs(body.url, zhouToken)).status, 200);
    await assertDenied(await fetchAs(body.url, linToken));
  });

  it('私聊里的附件只有两个当事人能下载', async () => {
    const dm = await direct(api, chenToken, zhou.id);
    const url = await uploadAs(chenToken);
    await send(dm.id, `![截图](${url})`, chenToken);
    assert.equal((await fetchAs(url, zhouToken)).status, 200);
    await assertDenied(await fetchAs(url, linToken));
    await assertDenied(await fetchAs(url, adminToken));      // 管理员也不例外
  });

  it('退群之后就下载不到了（成员判定是实时查的，不是发消息那一刻定死的）', async () => {
    // 单开一个群：这条用例会把周明踢出去，别让它污染后面几条用例的前提。
    const leaving = await group(api, adminToken, '附件鉴权 · 退群测试', [chen.id, zhou.id]);
    const url = await uploadAs(chenToken);
    await send(leaving.id, `![截图](${url})`, chenToken);
    assert.equal((await fetchAs(url, zhouToken)).status, 200);

    await api.post(`/api/conversations/${leaving.id}/leave`, {}, zhouToken);
    await assertDenied(await fetchAs(url, zhouToken));
  });
});

describe('附件下载 · 已停用的账号', () => {
  it('停用之后连自己发过的附件都下不到', async () => {
    const url = await uploadAs(chenToken);
    await send(roomA.id, `![截图](${url})`, chenToken);
    assert.equal((await fetchAs(url, chenToken)).status, 200);

    await api.post(`/api/users/${chen.id}/disable`, {}, adminToken);
    // 停用会把 auth_version +1 并删掉全部会话，旧凭据当场作废 —— 401 而不是 404。
    const res = await fetchAs(url, chenToken);
    assert.equal(res.status, 401);

    await api.post(`/api/users/${chen.id}/enable`, {}, adminToken);
    chenToken = await api.login(chen.email);                 // 恢复后要重新登录
    assert.equal((await fetchAs(url, chenToken)).status, 200);
  });
});

describe('附件下载 · 传了还没发出去的对象', () => {
  it('上传者本人取得回来（Composer 是选中文件那一刻就上传的）', async () => {
    const url = await uploadAs(chenToken);
    assert.equal((await fetchAs(url, chenToken)).status, 200);
  });

  it('别人拿到 key 也没用：还没发出去就还不属于任何会话', async () => {
    const url = await uploadAs(chenToken);
    await assertDenied(await fetchAs(url, zhouToken));
    await assertDenied(await fetchAs(url, adminToken));
  });
});

describe('附件下载 · 别人的 key 不能靠「发一条消息」把自己加进白名单', () => {
  it('把别人未发送的附件地址贴进自己的群，不会因此获得访问权', async () => {
    const url = await uploadAs(chenToken);                   // 陈子航传的，还没发
    // 林悦在自己的 B 群里贴出这个地址，试图让 attachment_refs 认下它。
    await send(roomB.id, `![偷来的](${url})`, linToken);
    await assertDenied(await fetchAs(url, linToken));
  });

  it('陈子航发到 A 群之后，B 群的人照样看不到', async () => {
    const url = await uploadAs(chenToken);
    await send(roomA.id, `![截图](${url})`, chenToken);
    await send(roomB.id, `![转贴](${url})`, linToken);        // 林悦不是 A 群的人，转不动
    await assertDenied(await fetchAs(url, linToken));
  });

  it('但真正能看到它的人可以转发：A 群的周明贴进他也在的群，那个群就看得到了', async () => {
    const roomC = await group(api, adminToken, '附件鉴权 · C 群', [zhou.id, lin.id]);
    const url = await uploadAs(chenToken);
    await send(roomA.id, `![截图](${url})`, chenToken);
    assert.equal((await fetchAs(url, zhouToken)).status, 200);

    await send(roomC.id, `![转发](${url})`, zhouToken);
    // 转发等价于「周明把图下下来重新发一遍」，拦它没有意义，所以 C 群的林悦能看到。
    assert.equal((await fetchAs(url, linToken)).status, 200);
  });
});

describe('附件下载 · 头像是另一套规则', () => {
  it('头像全员可见：不需要和对方在同一个会话里', async () => {
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'me.png');
    const res = await api.call('POST', '/api/auth/me/avatar', { token: chenToken, form });
    assert.equal(res.status, 200);
    const avatarUrl = res.body.user.avatarUrl;
    assert.match(avatarUrl, /^\/uploads\//);

    // 林悦和陈子航没有任何共同会话（A 群没有她），照样看得到头像 ——
    // 因为 /api/users 本来就把全站每个人的 avatarUrl 发给她了，按会话卡它毫无意义。
    assert.equal((await fetchAs(avatarUrl, linToken)).status, 200);
  });

  it('头像仍然要求登录：不带凭据是 401', async () => {
    const me = await api.get('/api/auth/me', chenToken);
    assert.equal((await fetchAs(me.body.user.avatarUrl, null)).status, 401);
  });

  it('头像仍然按图片内联返回，带 nosniff', async () => {
    const me = await api.get('/api/auth/me', chenToken);
    const served = await fetchAs(me.body.user.avatarUrl, linToken);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(served.headers.get('content-disposition'), null);
  });
});
