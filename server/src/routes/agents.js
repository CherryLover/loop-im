// hapi Agent 管理（管理员）：连接状态、Agent 启用清单、改名、测试连通性。
// 取代退役的 /api/ai/*（docs/hapi-Agent-接入方案.md §F「AI 管理页重做」）。
import { Router } from 'express';
import { authenticate, requireAdmin } from '../auth.js';
import { logEvent } from '../log.js';
import {
  agentsOverview, disableAgent, enableAgent, flavorOf, isValidAgentName, renameAgent,
} from '../hapi/agents.js';
import { configuredMachine, hapiConfig, health, isHapiConfigured, isMachineOnline } from '../hapi/client.js';

export const router = Router();
router.use(authenticate, requireAdmin);

// 管理页首屏：顺带和 hub 对一次账（启用中的用户随机器在线状态联动）。
router.get('/', async (_req, res) => {
  res.json(await agentsOverview());
});

router.put('/:key', (req, res) => {
  const key = String(req.params.key || '');
  if (!flavorOf(key)) return res.status(404).json({ error: '未知的 Agent 类型' });
  if (!isHapiConfigured()) return res.status(400).json({ error: '尚未配置 hapi 连接（HAPI_BASE_URL 等环境变量）' });

  const enabled = !!req.body?.enabled;
  const user = enabled ? enableAgent(key) : disableAgent(key);
  logEvent(enabled ? 'admin.agent.enabled' : 'admin.agent.disabled', { reqId: req.id, actorId: req.user.id, agent: key });
  res.json({ ok: true, user });
});

router.patch('/:key', (req, res) => {
  const key = String(req.params.key || '');
  if (!flavorOf(key)) return res.status(404).json({ error: '未知的 Agent 类型' });
  const name = String(req.body?.name || '').trim();
  // D3：名字用连字符拼接、不许有空格——提及输入和解析都按整名走。
  if (!isValidAgentName(name)) return res.status(400).json({ error: '名字不能为空、不能超过 32 字、不能包含空格（用连字符代替）' });
  const user = renameAgent(key, name);
  if (!user) return res.status(400).json({ error: '该 Agent 还没有启用过' });
  logEvent('admin.agent.renamed', { reqId: req.id, actorId: req.user.id, agent: key });
  res.json({ ok: true, user });
});

// 测试连通性：health → 列机器 → 找到配置的那台。一次把三层都验了（docs §C.1）。
router.post('/test', async (_req, res) => {
  if (!isHapiConfigured()) {
    return res.json({ ok: false, lines: ['未配置：需要 HAPI_BASE_URL / HAPI_TOKEN / HAPI_MACHINE_ID / HAPI_WORKROOT'] });
  }
  const lines = [];
  try {
    const h = await health();
    lines.push(`hub 连通 ✓（协议版本 ${h.protocolVersion ?? '?'}）`);
  } catch (err) {
    return res.json({ ok: false, lines: [...lines, `hub 不可达：${err.message}`] });
  }
  try {
    const machine = await configuredMachine();
    if (!machine) {
      lines.push(`找不到配置的机器（HAPI_MACHINE_ID=${hapiConfig().machineId.slice(0, 8)}…）`);
      return res.json({ ok: false, lines });
    }
    const host = machine.metadata?.host || machine.id.slice(0, 8);
    if (!isMachineOnline(machine)) {
      lines.push(`机器 ${host} 不在线（runner 未运行）`);
      return res.json({ ok: false, lines });
    }
    lines.push(`机器 ${host} 在线，runner 运行中 ✓`);
    lines.push(`工作目录根：${hapiConfig().workroot}`);
    return res.json({ ok: true, lines });
  } catch (err) {
    return res.json({ ok: false, lines: [...lines, `认证或机器查询失败：${err.message}`] });
  }
});
