// 账号停用 / 恢复。员工离职后账号不能再登录，但聊天记录必须留着——所以是停用，不是删除。
//
// 立刻生效这件事复用「管理员重置密码」那套手法（auth.js 的 disableUser：auth_version +1
// 且清空 sessions），外加一条独立于密码的 disabled_at 闸门；两者缺一不可：
// 光有 auth_version 只能踢掉旧凭据，本人拿正确的密码重新登录照样能进来。
import { startServer, ADMIN, ADMIN_PASSWORD, PASSWORD } from './helpers.js';
import { direct, group, member } from './fixtures.js';
import { PNG } from './samples.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, admin, adminId;

const disable = (userId, token) => api.post(`/api/users/${userId}/disable`, {}, token);
const enable = (userId, token) => api.post(`/api/users/${userId}/enable`, {}, token);

const userIn = async (token, userId) =>
  (await api.get('/api/users', token)).body.users.find((u) => u.id === userId);

before(async () => {
  api = await startServer();
  admin = await api.loginAdmin();
  adminId = (await api.get('/api/auth/me', admin)).body.user.id;
});
after(async () => { await api.close(); });

describe('停用账号 · 登录', () => {
  it('停用后不能登录，而且明说是账号被停用，不是密码不对', async () => {
    const target = await member('周离职');
    assert.equal((await api.post('/api/auth/login', { email: target.email, password: PASSWORD })).status, 200);

    assert.equal((await disable(target.id, admin)).status, 200);

    const res = await api.post('/api/auth/login', { email: target.email, password: PASSWORD });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /停用/);
    assert.ok(!/密码/.test(res.body.error), `不该把停用说成密码问题：${res.body.error}`);
    assert.equal(res.body.token, undefined);
  });

  it('密码本身没被动过：停用期间输错密码仍然只说「邮箱或密码不正确」', async () => {
    // 反过来说也一样——不知道密码的人不该靠这条错误探到「这个邮箱存在且已停用」。
    const target = await member('钱探针');
    await disable(target.id, admin);
    const res = await api.post('/api/auth/login', { email: target.email, password: '完全不对的密码' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, '邮箱或密码不正确');
  });
});

describe('停用账号 · 每一个鉴权入口都要挡住', () => {
  // 只挡 /auth/login 是不够的：已经登录的会话、SSE、上传、改密码都得当场失效。
  // 全站的鉴权只有 auth.js 的 authenticate 一个入口，所以这里逐条把它们点一遍，
  // 确认没有哪个 router 走了别的路。
  it('已经登录的那张 token，在所有接口上一起失效', async () => {
    const target = await member('孙在线');
    const token = await api.login(target.email);
    const dm = await direct(api, token, adminId);
    // 停用之前这些都是通的，先把这一点钉住，免得下面的 401 是别的原因造成的。
    assert.equal((await api.get('/api/auth/me', token)).status, 200);

    await disable(target.id, admin);

    const probes = [
      ['GET', '/api/auth/me'],
      ['POST', '/api/auth/ping'],
      ['POST', '/api/auth/logout'],
      ['PATCH', '/api/auth/me'],
      ['POST', '/api/auth/me/password'],
      ['GET', '/api/users'],
      ['POST', '/api/users'],
      ['GET', '/api/conversations'],
      ['POST', '/api/conversations/direct'],
      ['POST', '/api/conversations/group'],
      ['GET', `/api/conversations/${dm.id}`],
      ['GET', `/api/conversations/${dm.id}/messages`],
      ['POST', `/api/conversations/${dm.id}/messages`],
      ['POST', `/api/conversations/${dm.id}/read`],
      ['POST', `/api/conversations/${dm.id}/leave`],
      ['GET', '/api/messages/search?q=你好'],
      ['GET', '/api/stream'],
    ];
    for (const [method, path] of probes) {
      const res = await api.call(method, path, { token, body: method === 'GET' ? undefined : {} });
      assert.equal(res.status, 401, `${method} ${path} 停用后必须拒绝`);
      assert.match(res.body.error, /停用/, `${method} ${path} 的理由要说清楚是停用`);
    }
  });

  it('上传接口也挡住（它走的是 multipart，不是 JSON，容易被漏掉）', async () => {
    const target = await member('李上传');
    const token = await api.login(target.email);
    const form = () => {
      const f = new FormData();
      f.append('file', new Blob([PNG], { type: 'image/png' }), 'shot.png');
      return f;
    };
    assert.equal((await api.call('POST', '/api/uploads', { token, form: form() })).status, 201);

    await disable(target.id, admin);

    for (const path of ['/api/uploads', '/api/auth/me/avatar']) {
      const res = await api.call('POST', path, { token, form: form() });
      assert.equal(res.status, 401, `${path} 停用后必须拒绝`);
      assert.match(res.body.error, /停用/);
    }
  });

  it('改密码接口不能成为后门：停用的人不能靠改密码把自己救回来', async () => {
    const target = await member('吴自救');
    const token = await api.login(target.email);
    await disable(target.id, admin);

    const res = await api.post('/api/auth/me/password', { current: PASSWORD, next: '想换个新密码进来' }, token);
    assert.equal(res.status, 401);
    // 换发 token 是这个接口成功时才做的事，被挡住就不该有新凭据流出来。
    assert.equal(res.body.token, undefined);
    // 恢复之后原密码照样能用，说明刚才那次确实一个字节都没写进去。
    await enable(target.id, admin);
    assert.equal((await api.post('/api/auth/login', { email: target.email, password: PASSWORD })).status, 200);
  });

  it('token 参数走 query 的入口（SSE）同样挡住', async () => {
    // /api/stream 的凭据是从 ?token= 里读的（EventSource 带不了自定义头），
    // 跟 Authorization 头是同一个 authenticate，但值得单独点一次。
    const target = await member('郑实时');
    const token = await api.login(target.email);
    await disable(target.id, admin);

    const res = await fetch(`${api.baseUrl}/api/stream?token=${encodeURIComponent(token)}`);
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /停用/);
  });

  it('停用当场掐断已经建好的 SSE 连接，不等他自己关页面', async () => {
    // authenticate 只在建连那一刻跑一次，之后连接一直开着。不主动断开的话，
    // 被停用的人还能继续收到消息——「立刻生效」就成了半句话。
    const target = await member('冯长连');
    const token = await api.login(target.email);

    const res = await fetch(`${api.baseUrl}/api/stream?token=${encodeURIComponent(token)}`);
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    // 先读到握手那一行，确认连接确实建起来了。
    const hello = await reader.read();
    assert.ok(new TextDecoder().decode(hello.value).includes('connected'));

    await disable(target.id, admin);

    // 服务端 end() 之后这一读会拿到 done；超时兜底，免得挂死整个测试进程。
    const ended = await Promise.race([
      (async () => { for (;;) { const r = await reader.read(); if (r.done) return true; } })(),
      new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    assert.equal(ended, true, '停用后这条 SSE 连接必须被服务端关掉');
  });

  it('同一账号两台设备都在线，停用后两台一起失效', async () => {
    const target = await member('杨两台');
    const phone = await api.login(target.email);
    const laptop = await api.login(target.email);
    assert.equal((await api.get('/api/auth/me', phone)).status, 200);
    assert.equal((await api.get('/api/auth/me', laptop)).status, 200);

    await disable(target.id, admin);

    for (const stale of [phone, laptop]) {
      const res = await api.get('/api/auth/me', stale);
      assert.equal(res.status, 401);
      assert.match(res.body.error, /停用/);
    }
  });

  it('停用只影响目标账号，别人的登录不受牵连', async () => {
    const [a, b] = [await member('何无关'), await member('许照常')];
    const tokenB = await api.login(b.email);
    await disable(a.id, admin);
    assert.equal((await api.get('/api/auth/me', tokenB)).status, 200);
    assert.equal((await api.post('/api/auth/login', { email: b.email, password: PASSWORD })).status, 200);
  });

  it('管理员被停用后，管理接口也一起关上（不是只关普通成员的门）', async () => {
    const other = await member('副管理员', { role: 'admin' });
    const token = await api.login(other.email);
    // Aria 退役后 /api/ai/* 已删除，改用「停用别人」这个管理动作来验证管理接口的通断。
    const first = await member('先被他停用的人');
    assert.equal((await disable(first.id, token)).status, 200);

    await disable(other.id, admin);

    // 不能再停用别人了。
    const victim = await member('不该被牵连的人');
    const res = await disable(victim.id, token);
    assert.equal(res.status, 401);
    assert.match(res.body.error, /停用/);
  });

  it('issue #16 那道防御没被破坏：没有 ver 的老凭据仍然是「登录已过期」', async () => {
    // 停用的判定排在 ver 校验之前，得确认它没把老凭据的归因抢过去。
    const { default: jwt } = await import('jsonwebtoken');
    const normal = await member('赵老凭据');
    const legacy = jwt.sign({ sub: normal.id, role: normal.role }, process.env.JWT_SECRET, { expiresIn: '15d' });
    const res = await api.get('/api/auth/me', legacy);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, '登录已过期，请重新登录');
  });
});

describe('停用账号 · 在线状态与名单', () => {
  it('停用后立刻显示为离线，不用等 90 秒心跳窗口过期', async () => {
    const target = await member('秦刚在线');
    const token = await api.login(target.email);
    await api.post('/api/auth/ping', {}, token);      // 刚刚还在线
    assert.equal((await userIn(admin, target.id)).online, true);

    await disable(target.id, admin);

    const row = await userIn(admin, target.id);
    assert.equal(row.online, false);
    assert.equal(row.disabled, true);
  });

  it('仍然出现在成员名单里，名字和头像照常——停用不是删除', async () => {
    const target = await member('蒋留痕', { dept: '市场' });
    await disable(target.id, admin);
    const row = await userIn(admin, target.id);
    assert.ok(row, '停用的人不该从名单里消失');
    assert.equal(row.name, '蒋留痕');
    assert.equal(row.dept, '市场');
    assert.equal(row.email, target.email);
  });

  it('不能被拉进新群，也不能被加进已有的群', async () => {
    const [gone, stays] = [await member('邓已停'), await member('曹在职')];
    await disable(gone.id, admin);

    const created = await api.post('/api/conversations/group', { title: '新项目组', memberIds: [gone.id] }, admin);
    assert.equal(created.status, 400);
    assert.match(created.body.error, /停用/);

    const g = await group(api, admin, '老项目组', [stays.id]);
    const added = await api.post(`/api/conversations/${g.id}/members`, { userIds: [gone.id] }, admin);
    assert.equal(added.status, 400);
    assert.match(added.body.error, /停用/);
  });

  it('不能跟停用的人新开私聊，但已经聊过的那个会话照样打开', async () => {
    const target = await member('韩聊过');
    const existing = await direct(api, admin, target.id);
    await api.post(`/api/conversations/${existing.id}/messages`, { body: '离职前的最后一条' }, admin);

    await disable(target.id, admin);

    // 已有会话：照常打开，历史一条不少。
    const again = await api.post('/api/conversations/direct', { userId: target.id }, admin);
    assert.equal(again.status, 200);
    assert.equal(again.body.conversation.id, existing.id);
    const page = await api.get(`/api/conversations/${existing.id}/messages`, admin);
    assert.equal(page.status, 200);
    assert.ok(page.body.messages.some((m) => m.body === '离职前的最后一条'));

    // 没聊过的人：不给凭空开一个对方永远看不到的空会话。
    const stranger = await member('陌生管理员', { role: 'admin' });
    const strangerToken = await api.login(stranger.email);
    const fresh = await api.post('/api/conversations/direct', { userId: target.id }, strangerToken);
    assert.equal(fresh.status, 400);
    assert.match(fresh.body.error, /停用/);
  });
});

describe('停用账号 · 历史必须原样保留', () => {
  it('他发过的消息、群成员身份、头像和名字照常显示，不会变成「未知用户」', async () => {
    const leaver = await member('冯离职', { dept: '设计' });
    const stays = await member('沈留下');
    const g = await group(api, admin, '交接群', [leaver.id, stays.id]);
    const token = await api.login(leaver.email);
    await api.post(`/api/conversations/${g.id}/messages`, { body: '交接文档我放在共享盘了' }, token);

    await disable(leaver.id, admin);

    const detail = await api.get(`/api/conversations/${g.id}`, admin);
    assert.equal(detail.status, 200);
    const still = detail.body.conversation.members.find((m) => m.id === leaver.id);
    assert.ok(still, '停用不该把人踢出群');
    assert.equal(still.name, '冯离职');
    assert.equal(still.disabled, true);
    assert.equal(still.online, false);

    const page = await api.get(`/api/conversations/${g.id}/messages`, admin);
    const mine = page.body.messages.find((m) => m.body === '交接文档我放在共享盘了');
    assert.ok(mine, '他发过的消息必须还在');
    assert.equal(mine.senderName, '冯离职', '发送者名字照常，不能退化成 id 或「未知用户」');
    assert.equal(mine.senderId, leaver.id);
  });

  it('他发过的消息照样能被搜到，引用他的那条也照常显示他的名字', async () => {
    const leaver = await member('唐被引用');
    const g = await group(api, admin, '归档群', [leaver.id]);
    const token = await api.login(leaver.email);
    const sent = await api.post(`/api/conversations/${g.id}/messages`, { body: '发版流程见 wiki 第三节' }, token);
    const quotedId = sent.body.message.id;
    await api.post(`/api/conversations/${g.id}/messages`, { body: '收到', replyTo: quotedId }, admin);

    await disable(leaver.id, admin);

    const found = await api.get('/api/messages/search?q=' + encodeURIComponent('发版流程'), admin);
    assert.equal(found.status, 200);
    assert.ok(found.body.results.some((r) => r.body.includes('发版流程见 wiki 第三节')));

    const page = await api.get(`/api/conversations/${g.id}/messages`, admin);
    const reply = page.body.messages.find((m) => m.body === '收到');
    assert.equal(reply.quote.available, true);
    assert.equal(reply.quote.senderName, '唐被引用');
  });
});

describe('恢复账号', () => {
  it('恢复之后一切照旧：原密码能登录，名单上不再标停用', async () => {
    const target = await member('薛回来了');
    await disable(target.id, admin);
    assert.equal((await api.post('/api/auth/login', { email: target.email, password: PASSWORD })).status, 403);

    const res = await enable(target.id, admin);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.disabled, false);

    const back = await api.post('/api/auth/login', { email: target.email, password: PASSWORD });
    assert.equal(back.status, 200);
    assert.ok(back.body.token);
    assert.equal((await api.get('/api/auth/me', back.body.token)).status, 200);
    assert.equal((await userIn(admin, target.id)).disabled, false);
  });

  it('恢复后原来的群、私聊和历史消息都还在原处', async () => {
    const target = await member('尹归队');
    const g = await group(api, admin, '归队群', [target.id]);
    const before = await api.login(target.email);
    await api.post(`/api/conversations/${g.id}/messages`, { body: '停用前说的话' }, before);

    await disable(target.id, admin);
    await enable(target.id, admin);

    const after = await api.login(target.email);
    const list = await api.get('/api/conversations', after);
    assert.ok(list.body.conversations.some((c) => c.id === g.id), '群还在');
    const page = await api.get(`/api/conversations/${g.id}/messages`, after);
    assert.ok(page.body.messages.some((m) => m.body === '停用前说的话'));
    // 也能重新发言了。
    const sent = await api.post(`/api/conversations/${g.id}/messages`, { body: '我回来了' }, after);
    assert.equal(sent.status, 201);
  });

  it('恢复后可以重新被拉进新群', async () => {
    const target = await member('柳可拉');
    await disable(target.id, admin);
    await enable(target.id, admin);
    const created = await api.post('/api/conversations/group', { title: '恢复后的群', memberIds: [target.id] }, admin);
    assert.equal(created.status, 201);
  });

  it('停用期间发给他的私聊消息不会丢，恢复后照样看得到', async () => {
    // 这也是「停用期间别人还能往这个会话里发消息」这一设计的落点：
    // 消息留在那儿等他回来，而不是被拒收。
    const target = await member('孟收留言');
    const dm = await direct(api, admin, target.id);
    await disable(target.id, admin);
    const sent = await api.post(`/api/conversations/${dm.id}/messages`, { body: '离职手续记得办一下' }, admin);
    assert.equal(sent.status, 201, '别人往这个会话里发消息不受影响');

    await enable(target.id, admin);
    const token = await api.login(target.email);
    const page = await api.get(`/api/conversations/${dm.id}/messages`, token);
    assert.ok(page.body.messages.some((m) => m.body === '离职手续记得办一下'));
  });
});

describe('停用 / 恢复的边界', () => {
  it('不能停用自己：管理员把自己停了就再没人能恢复了', async () => {
    const res = await disable(adminId, admin);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /自己/);
    // 自己的登录状态一点没受影响。
    assert.equal((await api.get('/api/auth/me', admin)).status, 200);
    assert.equal((await api.post('/api/auth/login', { email: ADMIN, password: ADMIN_PASSWORD })).status, 200);
  });

  it('不能停用 AI 账号', async () => {
    // Aria 退役后全新库里不再有 id='ai' 那一行；这道闸门是按 role='ai' 判的，造一个来验证。
    const bot = await member('值守机器人', { role: 'ai' });
    const res = await disable(bot.id, admin);
    assert.equal(res.status, 400);
    const { get } = await import('../src/db.js');
    assert.equal(get('SELECT disabled_at FROM users WHERE id = ?', bot.id).disabled_at, null);
  });

  it('账号不存在时返回 404（停用和恢复都是）', async () => {
    assert.equal((await disable('u_nobody', admin)).status, 404);
    assert.equal((await enable('u_nobody', admin)).status, 404);
  });

  it('普通成员不能停用别人，目标账号也不会被动到', async () => {
    const [target, caller] = [await member('魏目标'), await member('毛普通')];
    const memberToken = await api.login(caller.email);

    const res = await disable(target.id, memberToken);
    assert.equal(res.status, 403);
    assert.equal((await api.post('/api/auth/login', { email: target.email, password: PASSWORD })).status, 200);

    // 恢复同理，不然普通成员就能把管理员停用的人放回来。
    await disable(target.id, admin);
    assert.equal((await enable(target.id, memberToken)).status, 403);
    assert.equal((await api.post('/api/auth/login', { email: target.email, password: PASSWORD })).status, 403);
  });

  it('未登录不能停用 / 恢复', async () => {
    const target = await member('未登录目标');
    assert.equal((await api.post(`/api/users/${target.id}/disable`, {})).status, 401);
    assert.equal((await api.post(`/api/users/${target.id}/enable`, {})).status, 401);
  });

  it('重复停用、重复恢复都是幂等的，不会报错也不会越加越多', async () => {
    const target = await member('穆重复');
    assert.equal((await disable(target.id, admin)).status, 200);
    assert.equal((await disable(target.id, admin)).status, 200);
    assert.equal((await api.post('/api/auth/login', { email: target.email, password: PASSWORD })).status, 403);

    assert.equal((await enable(target.id, admin)).status, 200);
    assert.equal((await enable(target.id, admin)).status, 200);
    assert.equal((await api.post('/api/auth/login', { email: target.email, password: PASSWORD })).status, 200);
  });

  it('停用不动密码：恢复后用的还是原来那把', async () => {
    const target = await member('葛原密码');
    const { get } = await import('../src/db.js');
    const before = get('SELECT password_hash FROM users WHERE id = ?', target.id).password_hash;
    await disable(target.id, admin);
    assert.equal(get('SELECT password_hash FROM users WHERE id = ?', target.id).password_hash, before);
  });
});
