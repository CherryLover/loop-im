// 管理员重置成员密码。系统发不了邮件，所以新密码只能在这里显示一次，由管理员抄给本人。
import { useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import type { User } from '../lib/types';

export function ResetPasswordModal({
  user, onClose,
}: {
  user: User;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const res = await api.resetUserPassword(user.id);
      setPassword(res.password);
    } catch (err) {
      setError(err instanceof Error ? err.message : '重置失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width={380}>
      <div>
        <div className="modal__title">重置密码</div>
        <div className="modal__sub">为 {user.name}（{user.email}）生成一个新密码</div>
      </div>

      {password ? (
        <>
          <div className="modal__ok">
            已重置，新密码：<strong style={{ fontFamily: "'JetBrains Mono', monospace" }}>{password}</strong>
          </div>
          <div className="modal__sub">
            这串密码只显示这一次，请立刻抄下来交给本人。{user.name} 在所有设备上的登录已失效，需用新密码重新登录。
          </div>
          <div className="modal__actions">
            <button type="button" className="btn btn--primary modal__btn" onClick={onClose}>完成</button>
          </div>
        </>
      ) : (
        <>
          <div className="modal__sub">
            重置后旧密码立刻作废，{user.name} 在所有设备上都会被登出，需要用新密码重新登录。
          </div>

          {error ? <div className="modal__error">{error}</div> : null}

          <div className="modal__actions">
            <button type="button" className="btn modal__btn" style={{ borderColor: 'var(--border2)' }} onClick={onClose}>取消</button>
            <button type="button" className="btn btn--primary modal__btn" onClick={submit} disabled={busy}>确认重置</button>
          </div>
        </>
      )}
    </Modal>
  );
}
