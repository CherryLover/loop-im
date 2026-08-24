import { useId, useRef, useState } from 'react';
import { Bell, BellOff, Moon, Sun } from 'lucide-react';
import { Modal } from '../components/Modal';
import { Avatar } from '../components/Avatar';
import { PasswordInput } from '../components/PasswordInput';
import { api, MAX_UPLOAD_MB } from '../lib/api';
import type { Theme } from '../lib/theme';
import type { NotifyPermission } from '../lib/notify';
import type { User } from '../lib/types';

/**
 * 开关旁边那一句人话。四件事都要说清楚，缺一件用户就会以为功能坏了：
 * - 环境不行时说明是**环境**不行（非 HTTPS / iOS 还没装到主屏 / 浏览器太老 / 权限被拒），
 *   别让开关默默失灵；而且要说到「下一步具体点哪儿」，光说「不支持」等于什么都没说；
 * - 已开启时说明**什么时候才会弹**——本产品只在用户看不见消息时弹，用户开完开关
 *   还停在聊天页就永远等不到，这不是 bug，但不写出来没人猜得到；
 * - 还没开时说明点下去会发生什么；
 * - **这个开关只管这一台设备。** 语义在推送这一版变了：它不再是「本地弹不弹窗」，
 *   而是「这台设备订不订阅推送」。关掉是真的退订（服务端不再往这台设备推），
 *   别的设备一点不受影响。不写明的话，用户在手机上关掉，会以为电脑上也一起关了。
 */
const notifyHint = (permission: NotifyPermission, enabled: boolean) => {
  if (permission === 'insecure') {
    return '当前不是 HTTPS（也不是 localhost），浏览器禁用了桌面通知，权限申请连弹都不会弹。'
      + '请改用 https:// 或 http://localhost 访问。';
  }
  // iOS 标签页这一档：绝不能说「换个浏览器」——iOS 上所有浏览器都是同一个 WebKit，
  // 换谁都一样。这里要说的是唯一能解决问题的那条路，而且要说到用户点得到的按钮名字。
  if (permission === 'needs-install') {
    return '在 iPhone / iPad 上，网页通知只对「添加到主屏幕」之后的应用生效，换别的浏览器没用（iOS 上都是同一个内核）。'
      + '点屏幕底部中间的分享按钮（方框里一个向上的箭头）→ 往下找到「添加到主屏幕」→ 添加，'
      + '之后从主屏图标打开本站，这个开关就能用了。'
      + '注意：主屏应用有自己独立的登录状态，第一次打开需要重新登录一次，登录时记得勾上「保持登录」。';
  }
  if (permission === 'unsupported') {
    return '当前浏览器不支持桌面通知。iPhone / iPad 需要 iOS 16.4 或更新版本，并且要从主屏图标打开。';
  }
  if (permission === 'denied') return '浏览器已拒绝本站的通知权限。需要到地址栏的站点设置里手动允许，这里才能再打开。';
  if (enabled) {
    return '只在你看不见这条消息时才弹：切到别的标签页、切到别的应用，或人在联系人 / AI 页时。'
      + '正开着这个会话就不弹（只标已读），免打扰的会话也不弹。'
      + '应用完全关掉时也会收到推送。'
      + '这个开关只管这一台设备：在这里关掉就是真的退订，本机不再收到任何推送，你的其它设备照常。';
  }
  return '打开后会向浏览器申请一次通知权限，成功后立刻弹一条确认通知，'
    + '并把这台设备登记为推送目标（应用没开着也能收到）。'
    + '之后只在你看不见消息时才弹：切到别的标签页、别的应用，或人在联系人 / AI 页时。'
    + '这个开关只管这一台设备，别的设备要各自打开一次。';
};

/**
 * 头像上传的三态。
 *
 * 用户反馈「选择图片后一直在 loading」——真实情况是**一点 loading 都没有**：
 * 以前从选中文件到请求结束，这个弹窗的 DOM 一个字都不变，按钮还照样能点，
 * 于是「界面毫无反应」被理解成「卡在 loading」。这里把中间态显式做出来。
 */
type AvatarState =
  | { phase: 'idle' }
  | { phase: 'uploading'; file: File }
  | { phase: 'done' }
  | { phase: 'failed'; file: File; message: string };

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
  const [avatar, setAvatar] = useState<AvatarState>({ phase: 'idle' });
  const fileRef = useRef<HTMLInputElement>(null);
  const notifyHintId = useId();

  const uploading = avatar.phase === 'uploading';

  async function upload(file: File) {
    // 先进「上传中」，再发请求：中间态必须在等待开始之前就落到界面上，
    // 否则慢网络下用户看到的仍然是一动不动的弹窗。
    setAvatar({ phase: 'uploading', file });
    setError('');
    try {
      const { user } = await api.uploadAvatar(file);
      onUpdated(user);
      setAvatar({ phase: 'done' });
    } catch (err) {
      // 失败不写进弹窗底部那行公共 error：头像的问题要贴在头像旁边，
      // 而且要留一个「重试」入口——同一张图重发一次往往就好了。
      setAvatar({ phase: 'failed', file, message: err instanceof Error ? err.message : '头像上传失败' });
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
        <span className={`avatar-slot${uploading ? ' avatar-slot--busy' : ''}`}>
          <Avatar name={me.name} url={me.avatarUrl} size={56} radius={16} />
          {/* 上传中在头像上盖一圈转圈：反馈得贴着用户正在改的那个东西。 */}
          {uploading ? <span className="avatar-slot__spinner" aria-hidden="true" /> : null}
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <button
            type="button"
            className="btn btn--sm"
            style={{ borderColor: 'var(--border2)' }}
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? '上传中…' : '上传新头像'}
          </button>
          <span className="section-label">图片不超过 {MAX_UPLOAD_MB}MB</span>

          {/* aria-live：上传是异步的，状态变化要主动播报，不能只靠用户盯着看。 */}
          <span className="avatar-status" role="status" aria-live="polite">
            {avatar.phase === 'uploading' ? (
              <span className="section-label">正在上传 {avatar.file.name}…</span>
            ) : null}
            {avatar.phase === 'done' ? <span className="modal__ok">头像已更新</span> : null}
            {avatar.phase === 'failed' ? (
              <>
                <span className="modal__error">{avatar.message}</span>
                <button
                  type="button"
                  className="btn btn--sm"
                  style={{ borderColor: 'var(--border2)' }}
                  onClick={() => void upload(avatar.file)}
                >
                  重试
                </button>
              </>
            ) : null}
          </span>

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
            // 按钮置灰的四种原因（非 HTTPS / iOS 还没装到主屏 / 浏览器不支持 / 权限被拒）
            // 各自都在下面那句话里写明了；aria-describedby + title 把说明挂到按钮上，
            // 读屏和悬停都能拿到，不至于只看到一个「点不动」的灰按钮。
            // 'needs-install' 也走置灰这条老路，不给它单开一种交互（比如变成一颗
            // 「怎么安装」按钮）：安装这件事浏览器不让网页代劳，多一个新控件只是多一处
            // 要维护的例外，说明文字已经承担了全部信息量。
            aria-describedby={notifyHintId}
            title={notifyHint(notifyPermission, notifyEnabled)}
            disabled={
              notifyPermission === 'insecure'
              || notifyPermission === 'needs-install'
              || notifyPermission === 'unsupported'
              || notifyPermission === 'denied'
            }
            onClick={onToggleNotify}
          >
            {notifyEnabled ? <Bell size={13} /> : <BellOff size={13} />}
            {notifyEnabled ? '已开启' : '已关闭'}
          </button>
        </div>
        <span className="section-label" id={notifyHintId}>{notifyHint(notifyPermission, notifyEnabled)}</span>
      </div>

      <div className="modal__section">
        <div className="section-label">修改密码</div>
        <PasswordInput placeholder="当前密码" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <PasswordInput placeholder="新密码" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <PasswordInput placeholder="确认新密码" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
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
