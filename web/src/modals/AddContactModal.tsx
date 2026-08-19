import { useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import type { User } from '../lib/types';

export function AddContactModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (user: User) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [dept, setDept] = useState('');
  const [error, setError] = useState('');
  const [initialPassword, setInitialPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const res = await api.addUser({ name: name.trim(), email: email.trim(), dept: dept.trim() });
      setInitialPassword(res.initialPassword);
      onCreated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width={380}>
      <div>
        <div className="modal__title">添加联系人</div>
        <div className="modal__sub">开通新成员账号，对方用邮箱和初始密码登录</div>
      </div>

      {initialPassword ? (
        <>
          <div className="modal__ok">
            已开通 {name}，初始密码：<strong style={{ fontFamily: "'JetBrains Mono', monospace" }}>{initialPassword}</strong>
          </div>
          <div className="modal__actions">
            <button type="button" className="btn btn--primary modal__btn" onClick={onClose}>完成</button>
          </div>
        </>
      ) : (
        <>
          <label className="field">
            姓名
            <input className="input" placeholder="如：吴思" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            邮箱
            <input className="input" placeholder="name@loop.dev" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            部门 / 角色
            <input className="input" placeholder="如：运营" value={dept} onChange={(e) => setDept(e.target.value)} />
          </label>

          {error ? <div className="modal__error">{error}</div> : null}

          <div className="modal__actions">
            <button type="button" className="btn modal__btn" style={{ borderColor: 'var(--border2)' }} onClick={onClose}>取消</button>
            <button type="button" className="btn btn--primary modal__btn" onClick={submit} disabled={busy}>添加</button>
          </div>
        </>
      )}
    </Modal>
  );
}
