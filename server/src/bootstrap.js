// 初始化账号。仓库里不保存任何用户名与密码：管理员来自环境变量，
// 本地想要一批联系人时用 DEMO_USERS 描述，两者都写在未入库的 .env 里。
import bcrypt from 'bcryptjs';
import { get, run, now, uid } from './db.js';
import { AI_ID, AI_NAME } from './ai.js';
import { isEncryptionConfigured } from './secret-box.js';

const AI_EMAIL = 'aria@system';

/** Aria 是系统账号：没有密码，也无法登录，只作为会话成员存在。 */
export function ensureAiAccount() {
  const name = process.env.AI_NAME || AI_NAME;
  const existing = get('SELECT * FROM users WHERE id = ?', AI_ID);
  if (existing) {
    if (existing.name !== name) run('UPDATE users SET name = ? WHERE id = ?', name, AI_ID);
    return false;
  }
  run(
    `INSERT INTO users (id, name, email, dept, role, password_hash, last_seen_at, created_at)
     VALUES (?, ?, ?, '系统 AI', 'ai', NULL, 0, ?)`,
    AI_ID, name, AI_EMAIL, now(),
  );
  return true;
}

export function createAccount({ name, email, dept = '成员', role = 'member', password }) {
  const id = uid('u');
  run(
    `INSERT INTO users (id, name, email, dept, role, password_hash, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    id, name, email.toLowerCase(), dept, role, bcrypt.hashSync(password, 10), now(),
  );
  return get('SELECT * FROM users WHERE id = ?', id);
}

const findByEmail = (email) => get('SELECT * FROM users WHERE lower(email) = ?', String(email).toLowerCase());

/** 首个管理员：只在账号不存在时创建，改了 .env 里的密码不会覆盖已有账号。 */
export function bootstrapAdmin({ name, email, password, dept } = {}) {
  const adminName = name || process.env.ADMIN_NAME || '管理员';
  const adminEmail = email || process.env.ADMIN_EMAIL;
  const adminPassword = password || process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) return { created: false, reason: 'missing-config' };
  if (findByEmail(adminEmail)) return { created: false, reason: 'exists' };
  const user = createAccount({
    name: adminName,
    email: adminEmail,
    dept: dept || process.env.ADMIN_DEPT || '管理',
    role: 'admin',
    password: adminPassword,
  });
  return { created: true, user };
}

/**
 * 本地开发用的联系人，格式：DEMO_USERS="姓名:邮箱:部门,姓名:邮箱:部门"
 * 密码统一取 DEMO_PASSWORD。留空则不创建任何人。
 */
export function bootstrapDemoUsers(spec = process.env.DEMO_USERS, password = process.env.DEMO_PASSWORD) {
  if (!spec || !password) return [];
  const created = [];
  for (const entry of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, email, dept] = entry.split(':').map((s) => (s || '').trim());
    if (!name || !email || findByEmail(email)) continue;
    created.push(createAccount({ name, email, dept: dept || '成员', password }));
  }
  return created;
}

/** 启动时跑一次：系统 AI + 管理员 + 可选的本地联系人。 */
export function bootstrap({ log = () => {} } = {}) {
  // 只告警不拦启动：现有部署没配这个变量，不能因为加了加密就起不来。
  if (!isEncryptionConfigured() && process.env.NODE_ENV === 'production') {
    log('⚠ 未设置 ENCRYPTION_KEY，AI 供应商的 API Key 仍以明文存库（见 server/.env.example）');
  }
  ensureAiAccount();
  const admin = bootstrapAdmin();
  if (admin.created) log(`已创建管理员 ${admin.user.email}`);
  else if (admin.reason === 'missing-config') log('未配置 ADMIN_EMAIL / ADMIN_PASSWORD，跳过管理员初始化');

  const demo = bootstrapDemoUsers();
  if (demo.length) log(`已创建 ${demo.length} 位本地联系人（DEMO_USERS）`);
  return { admin, demo };
}
