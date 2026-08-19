// Test people and conversations, created at runtime. Import helpers.js before this.
import { PASSWORD } from './helpers.js';

let seq = 0;

/** Creates a member account directly in the database and returns its row. */
export async function member(name, { dept = '产品', role = 'member', password = PASSWORD } = {}) {
  const { createAccount } = await import('../src/bootstrap.js');
  seq += 1;
  return createAccount({ name, email: `user${seq}@test.local`, dept, role, password });
}

/** Creates the given members in one go. */
export async function members(...names) {
  const out = [];
  for (const name of names) out.push(await member(name));
  return out;
}

/** Admin-created group; Aria joins automatically. */
export async function group(api, adminToken, title, memberIds) {
  const res = await api.post('/api/conversations/group', { title, memberIds }, adminToken);
  if (res.status !== 201) throw new Error(`group failed: ${JSON.stringify(res.body)}`);
  return res.body.conversation;
}

/** One-to-one conversation (or the AI conversation when peerId is 'ai'). */
export async function direct(api, token, peerId) {
  const res = await api.post('/api/conversations/direct', { userId: peerId }, token);
  if (res.status >= 400) throw new Error(`direct failed: ${JSON.stringify(res.body)}`);
  return res.body.conversation;
}
