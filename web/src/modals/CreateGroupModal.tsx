import { useState } from 'react';
import { Modal } from '../components/Modal';
import { Avatar } from '../components/Avatar';
import { api } from '../lib/api';
import type { User } from '../lib/types';

export function CreateGroupModal({
  users, meId, onClose, onCreated,
}: {
  users: User[];
  meId: string;
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 停用的账号登不进来，拉进新群只会多一个永远不说话的人，所以不进可选名单
  // （服务端也会拒，见 routes/conversations.js）。他在别处照常显示，这里只是不给选。
  // 建群是管理员专属入口，AI Agent 用户也可以在这里直接拉进群（D8）。
  const pickable = users.filter((u) => u.id !== meId && !u.disabled);

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  async function create() {
    setBusy(true);
    setError('');
    try {
      const { conversation } = await api.createGroup(name.trim() || '新群聊', picked);
      onCreated(conversation.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div>
        <div className="modal__title">创建群聊</div>
        <div className="modal__sub">至少选 1 名成员，建完还能随时增减；AI 助手默认加入</div>
      </div>

      <input className="input" placeholder="群名称" value={name} onChange={(e) => setName(e.target.value)} />

      <div className="modal__list">
        {pickable.map((u) => {
          const on = picked.includes(u.id);
          return (
            <button key={u.id} type="button" className={`pick${on ? ' pick--on' : ''}`} onClick={() => toggle(u.id)}>
              <span className="pick__box" />
              <Avatar name={u.name} url={u.avatarUrl} size={26} radius={8} />
              <span className="pick__name">{u.name}</span>
              <span className="pick__dept">{u.dept}</span>
            </button>
          );
        })}
      </div>

      {error ? <div className="modal__error">{error}</div> : null}

      <div className="modal__actions">
        <button type="button" className="btn modal__btn" style={{ borderColor: 'var(--border2)' }} onClick={onClose}>取消</button>
        <button
          type="button"
          className="btn btn--primary modal__btn"
          onClick={create}
          disabled={busy || picked.length < 1}
        >
          创建并进入（{picked.length}）
        </button>
      </div>
    </Modal>
  );
}
