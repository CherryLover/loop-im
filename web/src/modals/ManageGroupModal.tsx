import { useState } from 'react';
import { Modal } from '../components/Modal';
import { Avatar } from '../components/Avatar';
import { api } from '../lib/api';
import type { Conversation, User } from '../lib/types';

export type ManageMode = 'add' | 'rename' | 'leave';

/**
 * 群管理的三件事共用一个弹窗：加人、改群名、退群。
 * 权限由服务端把关（建群者或系统管理员），这里只负责界面。
 */
export function ManageGroupModal({
  mode, conversation, users, onClose, onDone,
}: {
  mode: ManageMode;
  conversation: Conversation;
  users: User[];
  onClose: () => void;
  onDone: (message: string, left?: boolean) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState(conversation.title);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const inGroup = new Set(conversation.members.map((m) => m.id));
  const pickable = users.filter((u) => !inGroup.has(u.id));

  async function run() {
    setBusy(true);
    setError('');
    try {
      if (mode === 'add') {
        await api.addMembers(conversation.id, picked);
        onDone(`已添加 ${picked.length} 名成员`);
      } else if (mode === 'rename') {
        const next = title.trim();
        await api.renameConversation(conversation.id, next);
        onDone(`群名已改为「${next}」`);
      } else {
        await api.leaveConversation(conversation.id);
        onDone(`已退出「${conversation.title}」`, true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
      setBusy(false);
    }
  }

  const disabled = busy
    || (mode === 'add' && picked.length === 0)
    || (mode === 'rename' && !title.trim());

  return (
    <Modal onClose={onClose}>
      <div>
        <div className="modal__title">
          {mode === 'add' ? '添加成员' : mode === 'rename' ? '修改群名' : '退出群聊'}
        </div>
        <div className="modal__sub">
          {mode === 'add' ? `已在群里的成员不会重复出现（当前 ${conversation.members.length} 人）`
            : mode === 'rename' ? '群里所有人都会看到这次改动'
              : `退出后将不再收到「${conversation.title}」的消息，需要群主或管理员重新拉你进来`}
        </div>
      </div>

      {mode === 'rename' ? (
        <input
          className="input"
          placeholder="群名称"
          aria-label="群名称"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      ) : null}

      {mode === 'add' ? (
        pickable.length ? (
          <div className="modal__list">
            {pickable.map((u) => {
              const on = picked.includes(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  className={`pick${on ? ' pick--on' : ''}`}
                  onClick={() => setPicked((p) => (on ? p.filter((x) => x !== u.id) : [...p, u.id]))}
                >
                  <span className="pick__box" />
                  <Avatar name={u.name} url={u.avatarUrl} isAI={u.isAI} size={26} radius={8} />
                  <span className="pick__name">{u.name}</span>
                  <span className="pick__dept">{u.dept}</span>
                </button>
              );
            })}
          </div>
        ) : <div className="modal__sub">所有人都已经在群里了。</div>
      ) : null}

      {error ? <div className="modal__error">{error}</div> : null}

      <div className="modal__actions">
        <button type="button" className="btn modal__btn" style={{ borderColor: 'var(--border2)' }} onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn--primary modal__btn" onClick={run} disabled={disabled}>
          {mode === 'add' ? `添加（${picked.length}）` : mode === 'rename' ? '保存' : '确认退出'}
        </button>
      </div>
    </Modal>
  );
}
