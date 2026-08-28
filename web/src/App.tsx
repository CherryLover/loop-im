import { useCallback, useEffect, useState } from 'react';
import { AppShell } from './AppShell';
import { LoginPage } from './pages/LoginPage';
import { api, clearToken, getToken } from './lib/api';
import { useTheme } from './lib/theme';
import type { User } from './lib/types';

export function App() {
  const { theme, toggle } = useTheme();
  const [session, setSession] = useState<{ user: User } | null>(null);
  const [checking, setChecking] = useState(!!getToken());
  const [justSignedIn, setJustSignedIn] = useState(false);

  useEffect(() => {
    if (!getToken()) return;
    api.me()
      .then((r) => setSession({ user: r.user }))
      .catch(() => clearToken())
      .finally(() => setChecking(false));
  }, []);

  const clearSession = useCallback(() => {
    clearToken();
    setSession(null);
    setJustSignedIn(false);
  }, []);

  // 主动退出：请求先发出去（此刻凭据还在，别人才会立刻看到离线），但不等它回来就清本地状态。
  // 服务端一删掉当前 session，同一凭据的在途请求就会拿回 401；等在这里的话，AppShell 还挂着，
  // 那些 401 会变成没人接的页面错误（issue #21）。先清状态，AppShell 随之卸载并取消在途请求。
  // 接口失败也不能卡住本地退出，那种情况仍由 90 秒的心跳窗口兜底。
  const signOut = useCallback(() => {
    const done = api.logout().catch(() => {
      /* 断网或服务端不可达：本地照样退出 */
    });
    clearSession();
    return done;
  }, [clearSession]);

  useEffect(() => {
    window.addEventListener('loop-im:signed-out', clearSession);
    return () => window.removeEventListener('loop-im:signed-out', clearSession);
  }, [clearSession]);

  if (checking) return <div className="app" />;

  if (!session) {
    return (
      <div className="app">
        <LoginPage
          onSignedIn={(user) => {
            setSession({ user });
            setJustSignedIn(true);
          }}
        />
      </div>
    );
  }

  return (
    <AppShell
      me={session.user}
      theme={theme}
      onToggleTheme={toggle}
      onSignOut={signOut}
      justSignedIn={justSignedIn}
    />
  );
}
