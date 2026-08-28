import { useId, useState } from 'react';
import { Logo } from '../components/Logo';
import { PasswordInput } from '../components/PasswordInput';
import { api, setToken } from '../lib/api';
import type { User } from '../lib/types';

export function LoginPage({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const passwordId = useId();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { token, user } = await api.login(email.trim(), password, remember);
      setToken(token, remember);
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login__form">
        <form className="login__inner" onSubmit={submit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="login__mark"><Logo size={19} /></div>
            <div className="login__title">登录 Loop IM</div>
            <div className="login__sub">用邮箱和密码登录，登录状态保留 15 天。</div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label className="login__label">
              邮箱
              <input
                className="input"
                type="email"
                autoComplete="username"
                placeholder="name@loop.dev"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            {/* 这里是 div + htmlFor，不是把输入框裹进 <label>：小眼睛按钮的 aria-label
                含「密码」二字，塞进 label 子树会混进输入框的可访问名。 */}
            <div className="login__label">
              <label htmlFor={passwordId}>密码</label>
              <PasswordInput
                id={passwordId}
                className="input"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>

          <label className="login__check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            保持登录 15 天（本机保存 token）
          </label>

          {error ? <div className="login__error">{error}</div> : null}

          <button className="login__submit" type="submit" disabled={busy}>
            {busy ? '登录中…' : '登录'}
          </button>
          <div className="login__note">成员账号由管理员开通，无需注册与加好友。</div>
        </form>
      </div>

      <div className="login__aside">
        <div className="login__aside-kicker">团队 IM</div>
        <div className="login__aside-lead">
          轻量的团队内部聊天：Markdown 消息、图片与文件、已读回执、
          手机上装到主屏还能收离线推送。
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
          <div className="login__bubble">周五能发版吗？后端还有两个接口。</div>
          <div className="login__bubble">接口预计周四完成，发版顺延到周一吧。</div>
        </div>
      </div>
    </div>
  );
}
