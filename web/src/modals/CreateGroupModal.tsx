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

  const pickable = users.filter((u) => u.id !== meId && !u.isAI);

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < 3 ? [...p, id] : p));
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
        <div className="modal__sub">选择 2–3 名成员，AI 助手默认加入</div>
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
          disabled={busy || picked.length < 2}
        >
          创建并进入（{picked.length}）
        </button>
      </div>
    </Modal>
  );
}
