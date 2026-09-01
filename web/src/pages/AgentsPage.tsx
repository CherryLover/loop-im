// hapi Agent 管理（管理员）：连接状态、Agent 启用清单、改名、测试连通性。
// 取代退役的 AiPage（docs/hapi-Agent-接入方案.md §F）。部署层配置（hub 地址、token、
// 机器、工作目录）在服务端 .env 里，这个页面只管产品层：启用哪些、叫什么名字。
import { useCallback, useEffect, useId, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { api } from '../lib/api';
import type { AgentInfo, AgentsStatus } from '../lib/types';

export function AgentsPage() {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; lines: string[] } | null>(null);

  const load = useCallback(() => {
    api.agentsStatus()
      .then((s) => { setStatus(s); setError(''); })
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'));
  }, []);

  useEffect(load, [load]);

  if (error) return <div className="page"><div className="page__hint">{error}</div></div>;
  if (!status) return <div className="page"><div className="page__hint">加载中…</div></div>;

  const statusLine = !status.configured
    ? '未配置 hapi 连接（见服务端 .env 的 HAPI_* 变量）'
    : status.machineOnline
      ? `已连接 · 机器 ${status.machineHost || ''} 在线`
      : status.hubError
        ? 'hub 不可达'
        : '机器不在线（启用中的 Agent 已临时隐身，恢复后自动回来）';

  return (
    <div className="page">
      <div className="ai-page">
        <div className="ai-page__head">
          <div>
            <div className="page__title">AI 管理</div>
            <div className="ai-page__status">
              <span className={`dot ${status.configured && status.machineOnline ? 'dot--online' : 'dot--offline'}`} />
              当前状态：{statusLine}
            </div>
          </div>
          <button
            type="button"
            className="btn"
            style={{ marginLeft: 'auto', borderColor: 'var(--border2)' }}
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              setTestResult(null);
              try {
                setTestResult(await api.testAgents());
              } catch (e) {
                setTestResult({ ok: false, lines: [e instanceof Error ? e.message : '测试失败'] });
              } finally {
                setTesting(false);
              }
            }}
          >
            {testing ? '测试中…' : '测试连通性'}
          </button>
        </div>

        {testResult ? (
          <div className="test-result" role="status">
            <span className={`dot ${testResult.ok ? 'dot--online' : 'dot--offline'}`} />
            <span>{testResult.lines.join('；')}</span>
          </div>
        ) : null}

        <div className="page__hint">
          机器上检测到的 Agent 会自动创建对应的 AI 用户，@ 它即可对话；不想用的可以随手关掉。
          未检测到的也可以手动打开（探测偶有漏网）。名字不能带空格（提及按整名匹配），用连字符代替。
        </div>

        <div className="card">
          {status.agents.map((a) => (
            <AgentRow key={a.key} agent={a} disabled={!status.configured} onChanged={load} />
          ))}
        </div>
      </div>
    </div>
  );
}

function AgentRow({ agent, disabled, onChanged }: { agent: AgentInfo; disabled: boolean; onChanged: () => void }) {
  const rowId = useId();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name);
  const [rowError, setRowError] = useState('');

  const toggle = async () => {
    setBusy(true);
    setRowError('');
    try {
      await api.setAgentEnabled(agent.key, !agent.enabled);
      onChanged();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const saveName = async () => {
    setRowError('');
    try {
      await api.renameAgent(agent.key, name.trim());
      setEditing(false);
      onChanged();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : '改名失败');
    }
  };

  return (
    <div className="rule">
      <Avatar name={agent.name} isAI size={30} radius={9} />
      <div style={{ minWidth: 0, flex: 1 }}>
        {editing ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              className="input"
              style={{ maxWidth: 180 }}
              value={name}
              aria-label={`${agent.label} 的显示名`}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                // 中文输入法下，结束组合的那个回车不算「保存」（同 Composer 的输入法保护）。
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter') void saveName();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <button type="button" className="btn btn--sm" onClick={() => void saveName()}>保存</button>
          </div>
        ) : (
          <div className="rule__name" id={`${rowId}-name`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {agent.name}
            {agent.enabled ? (
              <button
                type="button"
                className="icon-btn"
                aria-label={`修改 ${agent.name} 的名字`}
                onClick={() => { setName(agent.name); setEditing(true); }}
              >
                <Pencil size={12} />
              </button>
            ) : null}
          </div>
        )}
        <div className="rule__note" id={`${rowId}-note`}>
          {agent.label}
          {agent.available ? ' · 本机可用' : ' · 未检测到'}
          {rowError ? ` · ${rowError}` : agent.enabled && !agent.online ? ' · 暂不可用（机器离线）' : ''}
        </div>
      </div>
      <button
        type="button"
        className={`switch${agent.enabled ? ' switch--on' : ''}`}
        role="switch"
        aria-checked={agent.enabled}
        aria-labelledby={`${rowId}-name`}
        aria-describedby={`${rowId}-note`}
        disabled={busy || disabled}
        onClick={() => void toggle()}
      >
        <span />
      </button>
    </div>
  );
}
