// 管理员停用 / 恢复成员账号。员工离职后账号不能一直能登录，但聊天记录必须留着，
// 所以这里做的是停用，不是删除——弹窗的文案要把这一点说明白，别让管理员以为点下去
// 会把人和记录一起抹掉。
import { useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import type { User } from '../lib/types';

export function DisableUserModal({
  user, onClose, onDone,
}: {
  user: User;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 弹窗打开时的状态决定这次是停用还是恢复，一个组件管两件事。
  const disabling = !user.disabled;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.setUserDisabled(user.id, disabling);
      onDone(disabling ? `已停用 ${user.name} 的账号` : `已恢复 ${user.name} 的账号`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width={380}>
      <div>
        <div className="modal__title">{disabling ? '停用账号' : '恢复账号'}</div>
        <div className="modal__sub">{user.name}（{user.email}）</div>
      </div>

      <div className="modal__sub">
        {disabling ? (
          <>
            停用后 {user.name} 在所有设备上的登录立刻失效，也无法再登录、发消息，
            并且不会出现在建群和添加成员的可选名单里。
            <br />
            <strong>聊天记录不会被删除</strong>：他发过的消息、群成员身份、头像和名字照常显示，
            随时可以恢复。
          </>
        ) : (
          <>恢复后 {user.name} 可以用原来的密码重新登录，群聊、私聊和历史消息都还在原处。</>
        )}
      </div>

      {error ? <div className="modal__error">{error}</div> : null}

      <div className="modal__actions">
        <button type="button" className="btn modal__btn" style={{ borderColor: 'var(--border2)' }} onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn--primary modal__btn" onClick={submit} disabled={busy}>
          {disabling ? '确认停用' : '确认恢复'}
        </button>
      </div>
    </Modal>
  );
}
