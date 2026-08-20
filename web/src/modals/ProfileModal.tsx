import { useRef, useState } from 'react';
import { Bell, BellOff, Moon, Sun } from 'lucide-react';
import { Modal } from '../components/Modal';
import { Avatar } from '../components/Avatar';
import { api, MAX_UPLOAD_MB } from '../lib/api';
import type { Theme } from '../lib/theme';
import type { NotifyPermission } from '../lib/notify';
import type { User } from '../lib/types';

/** 权限被拒 / 浏览器不支持时给一句人话，而不是让开关默默失灵。 */
const notifyHint = (permission: NotifyPermission, enabled: boolean) => {
  if (permission === 'unsupported') return '当前浏览器不支持桌面通知。';
  if (permission === 'denied') return '浏览器已拒绝本站的通知权限。需要到地址栏的站点设置里手动允许，这里才能再打开。';
  if (enabled) return '切到别的标签页时，新消息会弹系统通知（免打扰的会话除外）。';
  return '打开后会向浏览器申请一次通知权限。';
};

export function ProfileModal({
  me, theme, onToggleTheme, notifyEnabled, notifyPermission, onToggleNotify, onClose, onUpdated, onSignOut,
}: {
  me: User;
  theme: Theme;
  onToggleTheme: () => void;
  notifyEnabled: boolean;
  notifyPermission: NotifyPermission;
  onToggleNotify: () => void;
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
          <span className="section-label">图片不超过 {MAX_UPLOAD_MB}MB</span>
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
        {/* 布局和「外观」那一行一样，但类名要分开：桌面通知不是外观设置，
            而且 .appearance 下只该有主题那一个按钮（e2e 靠它定位）。 */}
        <div className="setting-row">
          <span className="setting-row__label">桌面通知</span>
          <button
            type="button"
            className="btn btn--sm"
            aria-pressed={notifyEnabled}
            disabled={notifyPermission === 'unsupported' || notifyPermission === 'denied'}
            onClick={onToggleNotify}
          >
            {notifyEnabled ? <Bell size={13} /> : <BellOff size={13} />}
            {notifyEnabled ? '已开启' : '已关闭'}
          </button>
        </div>
        <span className="section-label">{notifyHint(notifyPermission, notifyEnabled)}</span>
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
