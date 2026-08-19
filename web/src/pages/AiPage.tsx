import { useCallback, useEffect, useId, useState } from 'react';
import { ChevronLeft, Settings } from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { api } from '../lib/api';
import { clock, relativeTime } from '../lib/format';
import type { AiOverview, AiProfileDetail } from '../lib/types';

type View = { name: 'list' } | { name: 'detail'; userId: string } | { name: 'config' };

export function AiPage({ onSettingsSaved }: { onSettingsSaved: () => void }) {
  const [view, setView] = useState<View>({ name: 'list' });
  const [overview, setOverview] = useState<AiOverview | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.aiOverview().then(setOverview).catch((e) => setError(e instanceof Error ? e.message : '加载失败'));
  }, []);

  useEffect(load, [load]);

  if (error) return <div className="page"><div className="page__hint">{error}</div></div>;
  if (!overview) return <div className="page"><div className="page__hint">加载中…</div></div>;

  if (view.name === 'detail') {
    return <AiPersonDetail userId={view.userId} onBack={() => setView({ name: 'list' })} />;
  }

  if (view.name === 'config') {
    return (
      <AiConfig
        overview={overview}
        onBack={() => setView({ name: 'list' })}
        onSaved={() => {
          load();
          onSettingsSaved();
        }}
      />
    );
  }

  return (
    <div className="page">
      <div className="ai-page">
        <div className="ai-page__head">
          <div>
            <div className="page__title">AI 管理</div>
            <div className="ai-page__status">
              <span className={`dot ${overview.configured ? 'dot--online' : 'dot--offline'}`} />
              当前状态：{overview.statusLine}
            </div>
          </div>
          <button type="button" className="btn" style={{ marginLeft: 'auto', borderColor: 'var(--border2)' }} onClick={() => setView({ name: 'config' })}>
            <Settings size={13} />
            AI 配置
          </button>
        </div>

        <div className="page__hint">Aria 正在跟踪的对话对象，点击查看推导出的偏好与习惯。</div>

        <div className="stats">
          {overview.stats.map((s) => (
            <div key={s.key} className="stat">
              <div className="stat__label">{s.label}</div>
              <div className="stat__value">{s.value}</div>
              <div className="stat__note">{s.note}</div>
            </div>
          ))}
        </div>

        <div className="table">
          <div className="table__head">
            <span className="col-person">对话对象</span>
            <span className="col-scene">场景</span>
            <span className="col-keys">关键信息点</span>
            <span className="col-last">最后活跃</span>
          </div>
          {overview.rows.map((r) => (
            <button key={r.userId} type="button" className="table__row" onClick={() => setView({ name: 'detail', userId: r.userId })}>
              <span className="col-person">
                <Avatar name={r.name} url={r.avatarUrl} size={28} radius={9} />
                <span>{r.name}</span>
              </span>
              <span className="col-scene">{r.scene}</span>
              <span className="col-keys">
                {r.keys.map((k) => <span key={k} className="chip">{k}</span>)}
              </span>
              <span className="col-last">{relativeTime(r.lastActiveAt)}</span>
            </button>
          ))}
          {overview.rows.length === 0 ? <div className="convos__empty">还没有可分析的对话。</div> : null}
        </div>
      </div>
    </div>
  );
}

function AiPersonDetail({ userId, onBack }: { userId: string; onBack: () => void }) {
  const [data, setData] = useState<AiProfileDetail | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.aiProfile(userId).then(setData).catch((e) => setError(e instanceof Error ? e.message : '加载失败'));
  }, [userId]);

  const back = (
    <button type="button" className="btn" style={{ alignSelf: 'flex-start', borderColor: 'var(--border2)' }} onClick={onBack}>
      <ChevronLeft size={13} />
      返回列表
    </button>
  );

  if (error) return <div className="page"><div className="ai-detail">{back}<div className="page__hint">{error}</div></div></div>;
  if (!data) return <div className="page"><div className="ai-detail">{back}<div className="page__hint">加载中…</div></div></div>;

  const { profile, raw } = data;

  return (
    <div className="page">
      <div className="ai-detail">
        {back}

        <div className="ai-detail__head">
          <Avatar name={profile.name} url={profile.avatarUrl} size={44} radius={13} />
          <div>
            <div className="ai-detail__name">{profile.name}</div>
            <div className="ai-detail__sub">{profile.scene} · 最后活跃 {relativeTime(profile.lastActiveAt)}</div>
          </div>
        </div>

        <div className="derived">
          <div className="derived__label">AI 推导 · 沟通偏好与习惯</div>
          <div className="derived__note">{profile.note || profile.summary || '还在积累这个人的沟通样本。'}</div>
          <div className="bullets">
            {profile.habits.map((h) => (
              <div key={h} className="bullet">
                <span className="bullet__dot" />
                <span>{h}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="section-label" style={{ marginBottom: 9 }}>关键信息点</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {profile.keys.map((k) => <span key={k} className="chip" style={{ padding: '3px 8px', fontSize: 12 }}>{k}</span>)}
            {profile.keys.length === 0 ? <span className="page__hint">暂无</span> : null}
          </div>
        </div>

        <button type="button" className="btn" style={{ alignSelf: 'flex-start', borderColor: 'var(--border2)' }} onClick={() => setRawOpen((v) => !v)}>
          {rawOpen ? '收起原始对话' : '查看详细 · 原始对话'}
        </button>

        {rawOpen ? (
          <div className="panel raw">
            <div className="section-label">原始对话记录</div>
            {raw.map((m, i) => (
              <div key={i} className="raw__row">
                <span className="raw__name">{m.name}</span>
                <span className="raw__text">{m.text}</span>
                <span className="raw__time">{clock(m.createdAt)}</span>
              </div>
            ))}
            {raw.length === 0 ? <div className="page__hint">暂无对话记录。</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AiConfig({
  overview, onBack, onSaved,
}: {
  overview: AiOverview;
  onBack: () => void;
  onSaved: () => void;
}) {
  const ruleId = useId();
  const [provider, setProvider] = useState(overview.provider);
  const [apiKey, setApiKey] = useState('');
  const [rules, setRules] = useState(overview.rules);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const patch = () => ({
    provider,
    ...(apiKey ? { apiKey } : {}),
    silentRead: rules.silentRead,
    replyAtAll: rules.replyAtAll,
    allowDm: rules.allowDm,
  });

  async function save() {
    setBusy(true);
    try {
      await api.saveAiSettings(patch());
      setSaved(true);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setResult(null);
    try {
      await api.saveAiSettings(patch());
      onSaved();
      setResult(await api.testAi());
    } finally {
      setBusy(false);
    }
  }

  const ruleRows: { key: keyof typeof rules; name: string; note: string }[] = [
    { key: 'silentRead', name: '群聊静默读取上下文', note: '未被 @ 时不发言，但持续记录谁说了什么' },
    { key: 'replyAtAll', name: '@全员 时 AI 也回复', note: '关闭后仅 @Aria 触发回复' },
    { key: 'allowDm', name: '允许成员与 AI 私聊', note: '一对一会话，独立记忆' },
  ];

  return (
    <div className="page">
      <div className="ai-config">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="btn" style={{ borderColor: 'var(--border2)' }} onClick={onBack}>
            <ChevronLeft size={13} />
            返回
          </button>
          <div style={{ fontSize: 17, fontWeight: 700 }}>AI 配置</div>
        </div>

        <div className="page__hint" style={{ marginTop: 0 }}>选择系统使用的 AI Agent。</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="section-label">AI Agent</div>
          {overview.providers.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`provider${provider === p.key ? ' provider--on' : ''}`}
              onClick={() => setProvider(p.key)}
            >
              <span className="provider__radio" />
              <span style={{ minWidth: 0 }}>
                <span className="provider__name">{p.name}</span>
                <span className="provider__note">{p.note}</span>
              </span>
              <span className="provider__model">{p.model}</span>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="section-label">API Key / 本地凭据</div>
          <input
            className="input input--mono"
            type="password"
            placeholder={overview.hasApiKey ? '已保存，留空表示不修改' : 'sk-…'}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setSaved(false);
            }}
          />
        </div>

        <div className="list-card">
          {ruleRows.map((r) => (
            <div key={r.key} className="rule">
              <div style={{ minWidth: 0 }}>
                <div className="rule__name" id={`${ruleId}-${r.key}-name`}>{r.name}</div>
                <div className="rule__note" id={`${ruleId}-${r.key}-note`}>{r.note}</div>
              </div>
              <button
                type="button"
                className={`switch${rules[r.key] ? ' switch--on' : ''}`}
                role="switch"
                aria-checked={rules[r.key]}
                aria-labelledby={`${ruleId}-${r.key}-name`}
                aria-describedby={`${ruleId}-${r.key}-note`}
                onClick={() => {
                  setRules((v) => ({ ...v, [r.key]: !v[r.key] }));
                  setSaved(false);
                }}
              >
                <span />
              </button>
            </div>
          ))}
        </div>

        {result ? (
          <div className={`test-result ${result.ok ? 'test-result--ok' : 'test-result--bad'}`}>
            <span className="dot" style={{ background: 'currentColor' }} />
            {result.message}
          </div>
        ) : null}
        {saved && !result ? <div className="test-result test-result--ok"><span className="dot" style={{ background: 'currentColor' }} />配置已保存</div> : null}

        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn--primary" style={{ borderRadius: 10, padding: '10px 16px', fontSize: 13.5 }} onClick={save} disabled={busy}>
            保存配置
          </button>
          <button type="button" className="btn" style={{ borderColor: 'var(--border2)', borderRadius: 10, padding: '10px 16px', fontSize: 13.5 }} onClick={test} disabled={busy}>
            测试连通性
          </button>
        </div>
      </div>
    </div>
  );
}
