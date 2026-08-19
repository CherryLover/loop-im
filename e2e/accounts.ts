// Throwaway accounts for the end-to-end run. They are created by the server's
// bootstrap from the env vars in playwright.config.ts and never exist elsewhere.
export const ADMIN = {
  name: '测试管理员',
  email: 'e2e-admin@example.test',
  password: 'e2e-only-admin-password',
};

export const MEMBER_PASSWORD = 'e2e-only-member-password';

export const MEMBERS = [
  { name: '陈子航', email: 'e2e-chen@example.test', dept: '后端' },
  { name: '周明', email: 'e2e-zhou@example.test', dept: '前端' },
  { name: '苏晴', email: 'e2e-su@example.test', dept: '设计' },
];
