// hapi Agent → 本系统 AI 用户 的映射与联动（docs/hapi-Agent-接入方案.md §C.2）。
//
// 0.27.3 的现实：hub 没有「这台机器装了哪些 Agent」的接口（agent-availability 是
// 后来主干上的新东西），所以可用性只到「配置的那台机器在不在线」这一层——
// 机器在线 = 管理员启用的 Agent 全部可用；机器离线 = 全体停用。
// 某个 Agent 其实没装的情形，等真正 @ 它开会话失败时按 D6 回「暂不可用」。
import { all, get, run, now } from '../db.js';
import { emitAll } from '../events.js';
import { publicUser } from '../auth.js';
import { logEvent, logWarn } from '../log.js';
import { configuredMachine, isHapiConfigured, isMachineOnline } from './client.js';

/**
 * 0.27.3 支持的全部 Agent 类型与官方显示名（shared/src/flavors.ts 的 FLAVOR_LABELS）。
 * 用户名按 D3 规则由显示名派生：空格换连字符。管理员可改名，但这是默认值。
 */
export const AGENT_FLAVORS = [
  { key: 'claude', label: 'Claude' },
  { key: 'codex', label: 'Codex' },
  { key: 'gemini', label: 'Gemini' },
  { key: 'kimi', label: 'Kimi' },
  { key: 'copilot', label: 'Copilot' },
  { key: 'grok', label: 'Grok Build' },
  { key: 'cursor', label: 'Cursor' },
  { key: 'opencode', label: 'OpenCode' },
  { key: 'pi', label: 'Pi' },
  { key: 'agy', label: 'Antigravity' },
];

export const flavorOf = (key) => AGENT_FLAVORS.find((f) => f.key === key) || null;
export const agentUserId = (key) => `ai-${key}`;
export const defaultAgentName = (key) => (flavorOf(key)?.label || key).replace(/\s+/g, '-');

/** Agent 用户的名字不许带空格（D3）：提及解析和 @ 输入都按连字符的整名走。 */
export const isValidAgentName = (name) =>
  typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 32 && !/\s/.test(name.trim());

/**
 * 启用一个 Agent：建（或复活）它的用户行 + hapi_agents 记录。幂等，id 稳定，
 * 反复开关不会产生重复用户（docs §C.2）。返回它的公开用户对象。
 */
export function enableAgent(key) {
  const flavor = flavorOf(key);
  if (!flavor) return null;
  const id = agentUserId(key);
  const ts = now();
  const existing = get('SELECT * FROM users WHERE id = ?', id);
  if (!existing) {
    run(
      `INSERT INTO users (id, name, email, dept, role, password_hash, last_seen_at, created_at)
       VALUES (?, ?, ?, 'AI Agent', 'ai', NULL, 0, ?)`,
      id, defaultAgentName(key), `${key}@hapi.local`, ts,
    );
  } else if (existing.disabled_at) {
    run('UPDATE users SET disabled_at = NULL WHERE id = ?', id);
  }
  run(
    `INSERT INTO hapi_agents (agent_key, user_id, enabled, updated_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(agent_key) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at`,
    key, id, ts,
  );
  const user = publicUser(get('SELECT * FROM users WHERE id = ?', id));
  emitAll(existing ? 'user-updated' : 'user-created', { user });
  return user;
}

/**
 * 停用一个 Agent（管理员取消勾选，或机器离线的联动）。复用「停用即隐身」的老语义：
 * 用户行保留、历史照常显示，停用的 AI 用户不出现在联系人接口里（routes/users.js）。
 * keepEnabled=true 用于「机器离线但管理员的勾选不变」：人下线，配置还在。
 */
export function disableAgent(key, { keepEnabled = false } = {}) {
  const id = agentUserId(key);
  const existing = get('SELECT * FROM users WHERE id = ?', id);
  if (!keepEnabled) {
    run('UPDATE hapi_agents SET enabled = 0, updated_at = ? WHERE agent_key = ?', now(), key);
  }
  if (!existing || existing.disabled_at) return existing ? publicUser(existing) : null;
  run('UPDATE users SET disabled_at = ? WHERE id = ?', now(), id);
  const user = publicUser(get('SELECT * FROM users WHERE id = ?', id));
  emitAll('user-updated', { user });
  return user;
}

/** 管理员改显示名（D3 校验过再进来）。改名走和人类改名同一条广播，界面就地更新。 */
export function renameAgent(key, name) {
  const id = agentUserId(key);
  if (!get('SELECT 1 AS x FROM users WHERE id = ?', id)) return null;
  run('UPDATE users SET name = ? WHERE id = ?', name.trim(), id);
  const user = publicUser(get('SELECT * FROM users WHERE id = ?', id));
  emitAll('user-updated', { user });
  return user;
}

export const enabledAgents = () => all('SELECT * FROM hapi_agents WHERE enabled = 1');
export const agentRow = (key) => get('SELECT * FROM hapi_agents WHERE agent_key = ?', key);

/** 会话是可抛弃的现场：重开就地覆盖记录（docs §C.3）。 */
export function setAgentSession(key, sessionId) {
  run('UPDATE hapi_agents SET session_id = ?, updated_at = ? WHERE agent_key = ?', sessionId, now(), key);
}

/**
 * 与 hub 对一次账：配置的机器在线 → 启用中的 Agent 用户全部上线；
 * 机器离线 / hub 失联 → 全部停用（但保留管理员的勾选，恢复后自动回来）。
 * 返回给管理页用的状态汇总；未配置时一切为空。
 */
export async function syncAgentsWithHub({ fetchImpl } = {}) {
  if (!isHapiConfigured()) return { configured: false, machineOnline: false, machine: null, hubError: null };

  let machine = null;
  let hubError = null;
  try {
    machine = await configuredMachine(fetchImpl ? { fetchImpl } : undefined);
  } catch (err) {
    hubError = String(err.message || err);
    logWarn('hapi.sync.hub_unreachable', { detail: hubError });
  }
  const online = isMachineOnline(machine);

  for (const row of enabledAgents()) {
    const user = get('SELECT * FROM users WHERE id = ?', row.user_id);
    if (!user) continue;
    if (online && user.disabled_at) {
      run('UPDATE users SET disabled_at = NULL WHERE id = ?', user.id);
      emitAll('user-updated', { user: publicUser(get('SELECT * FROM users WHERE id = ?', user.id)) });
    } else if (!online && !user.disabled_at) {
      disableAgent(row.agent_key, { keepEnabled: true });
    }
  }
  if (!online) logEvent('hapi.sync.machine_offline', { hubError });
  return { configured: true, machineOnline: online, machine, hubError };
}

/** 管理页的完整状态：连接情况 + 每种 Agent 的启用/用户信息。 */
export async function agentsOverview({ fetchImpl } = {}) {
  const sync = await syncAgentsWithHub({ fetchImpl });
  const rows = new Map(all('SELECT * FROM hapi_agents').map((r) => [r.agent_key, r]));
  const agents = AGENT_FLAVORS.map((f) => {
    const row = rows.get(f.key);
    const user = row ? get('SELECT * FROM users WHERE id = ?', row.user_id) : null;
    return {
      key: f.key,
      label: f.label,
      defaultName: defaultAgentName(f.key),
      enabled: !!row?.enabled,
      name: user?.name || defaultAgentName(f.key),
      userId: row?.user_id || agentUserId(f.key),
      online: !!(row?.enabled && sync.machineOnline),
    };
  });
  return {
    configured: sync.configured,
    machineOnline: sync.machineOnline,
    machineHost: sync.machine?.metadata?.host || null,
    hubError: sync.hubError,
    agents,
  };
}
