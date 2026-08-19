import { useRef, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Modal } from '../components/Modal';
import { Avatar } from '../components/Avatar';
import { api } from '../lib/api';
import type { Theme } from '../lib/theme';
import type { User } from '../lib/types';

export function ProfileModal({
  me, theme, onToggleTheme, onClose, onUpdated, onSignOut,
}: {
  me: User;
  theme: Theme;
  onToggleTheme: () => void;
  onClose: () => void;
  onUpdated: (user: User) => void;
  onSignOut: () => void;
}) {
  const [name, setName] = useState(me.name);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setError('');
    try {
      const { user } = await api.uploadAvatar(file);
      onUpdated(user);
      setOk('头像已更新');
    } catch (err) {
      setError(err instanceof Error ? err.message : '头像上传失败');
    }
  }

  async function save() {
    setBusy(true);
    setError('');
    setOk('');
    try {
      if (name.trim() && name.trim() !== me.name) {
        const { user } = await api.updateName(name.trim());
        onUpdated(user);
      }
      if (current || next || confirm) {
        if (next !== confirm) throw new Error('两次输入的新密码不一致');
        await api.changePassword(current, next);
        setCurrent('');
        setNext('');
        setConfirm('');
      }
      setOk('已保存');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="modal__title">个人资料</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Avatar name={me.name} url={me.avatarUrl} size={56} radius={16} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button type="button" className="btn btn--sm" style={{ borderColor: 'var(--border2)' }} onClick={() => fileRef.current?.click()}>
            上传新头像
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      <label className="field">
        昵称
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <div className="appearance">
        <span className="appearance__label">外观</span>
        <button type="button" className="btn btn--sm" onClick={onToggleTheme}>
          {theme === 'light' ? <Sun size={13} /> : <Moon size={13} />}
          {theme === 'light' ? '浅色' : '深色'}
        </button>
      </div>

      <div className="modal__section">
        <div className="section-label">修改密码</div>
        <input className="input" type="password" placeholder="当前密码" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <input className="input" type="password" placeholder="新密码" value={next} onChange={(e) => setNext(e.target.value)} />
        <input className="input" type="password" placeholder="确认新密码" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>

      {error ? <div className="modal__error">{error}</div> : null}
      {ok && !error ? <div className="modal__ok">{ok}</div> : null}

      <div className="modal__actions">
        <button type="button" className="btn modal__btn" style={{ marginRight: 'auto', borderColor: 'var(--border2)' }} onClick={onSignOut}>
          退出登录
        </button>
        <button type="button" className="btn modal__btn" style={{ borderColor: 'var(--border2)' }} onClick={onClose}>取消</button>
        <button type="button" className="btn btn--primary modal__btn" onClick={save} disabled={busy}>保存</button>
      </div>
    </Modal>
  );
}
