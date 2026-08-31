// hapi Agent → 本系统 AI 用户 的映射与联动（docs/hapi-Agent-接入方案.md §C.2）。
//
// 可用性两层：机器层（配置的 runner 在不在线，来自 hub）+ Agent 层（机器上装没装
// 这家 CLI，见 availableAgentKeys——0.27.3 的 hub 没有远程探测接口，探测是我们
// 自己做的）。机器在线时，可用的 Agent 自动建成用户；离线全体隐身。
// 探测漏网的（false negative）仍可手动启用，真没装的等 @ 时按 D6 回「暂不可用」。
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { all, get, run, now } from '../db.js';
import { emitAll } from '../events.js';
import { publicUser } from '../auth.js';
import { logEvent, logWarn } from '../log.js';
import { configuredMachine, isHapiConfigured, isMachineOnline } from './client.js';

/**
 * 0.27.3 支持的全部 Agent 类型与官方显示名（shared/src/flavors.ts 的 FLAVOR_LABELS）。
 * 用户名按 D3 规则由显示名派生：空格换连字符。管理员可改名，但这是默认值。
 * bin 是各家 CLI 的真实命令名，供本机探测（`HAPI_AGENTS=auto`）用。
 * gemini 不在清单里：0.27.3 的 hub 对它写死拒绝启动（Google 已下线其 CLI）。
 */
export const AGENT_FLAVORS = [
  { key: 'claude', label: 'Claude', bin: 'claude' },
  { key: 'codex', label: 'Codex', bin: 'codex' },
  { key: 'kimi', label: 'Kimi', bin: 'kimi' },
  { key: 'copilot', label: 'Copilot', bin: 'copilot' },
  { key: 'grok', label: 'Grok Build', bin: 'grok' },
  { key: 'cursor', label: 'Cursor', bin: 'cursor-agent' },
  { key: 'opencode', label: 'OpenCode', bin: 'opencode' },
  { key: 'pi', label: 'Pi', bin: 'pi' },
  { key: 'agy', label: 'Antigravity', bin: 'agy' },
];

/**
 * 这台机器（runner 所在机器）上有哪些 Agent 可用。
 *
 * `HAPI_AGENTS` 三档：
 * - 不设 / 'auto'：在本机 PATH 里逐个找各家 CLI 命令。前提是 Loop IM 与 runner
 *   同机同环境——本地开发正是如此；hub 侧没有可靠的远程探测（0.27.3 的
 *   paths/exists 只认目录，配置目录残留会误报，实测 copilot/opencode 中招）。
 * - 显式列表（如 'claude,codex'）：就这些。线上 Loop IM 跑在容器里、runner 在
 *   宿主机，容器里探测不到宿主的命令，部署时在 .env 里写清单（装了哪些写哪些）。
 * - 'all'：全部类型都算可用（不想探测时的开关）；'none'：一个都不自动加（测试用）。
 */
export function availableAgentKeys() {
  const spec = (process.env.HAPI_AGENTS || 'auto').trim();
  if (spec === 'all') return new Set(AGENT_FLAVORS.map((f) => f.key));
  if (spec === 'none') return new Set();
  if (spec && spec !== 'auto') {
    return new Set(spec.split(',').map((x) => x.trim()).filter((x) => flavorOf(x)));
  }
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const found = new Set();
  for (const f of AGENT_FLAVORS) {
    for (const dir of dirs) {
      try {
        accessSync(join(dir, f.bin), constants.X_OK);
        found.add(f.key);
        break;
      } catch { /* 这个目录没有，接着找 */ }
    }
  }
  return found;
}

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

  // 机器上可用的 Agent **自动**建成用户（用户拍板：支持哪些就都加进去）。
  // 只做加法：管理员手动关掉的（行在但 enabled=0）尊重其选择，不强行拉回。
  const available = availableAgentKeys();
  if (online) {
    for (const key of available) {
      if (!agentRow(key)) {
        enableAgent(key);
        logEvent('hapi.agent.auto_enabled', { agent: key });
      }
    }
  }

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
  return { configured: true, machineOnline: online, machine, hubError, available };
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
      available: sync.available ? sync.available.has(f.key) : false,
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
