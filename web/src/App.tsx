import { useCallback, useEffect, useState } from 'react';
import { AppShell } from './AppShell';
import { LoginPage } from './pages/LoginPage';
import { api, clearToken, getToken } from './lib/api';
import { useTheme } from './lib/theme';
import type { AiPublicInfo, User } from './lib/types';

export function App() {
  const { theme, toggle } = useTheme();
  const [session, setSession] = useState<{ user: User; ai: AiPublicInfo } | null>(null);
  const [checking, setChecking] = useState(!!getToken());
  const [justSignedIn, setJustSignedIn] = useState(false);

  useEffect(() => {
    if (!getToken()) return;
    api.me()
      .then((r) => setSession({ user: r.user, ai: r.ai }))
      .catch(() => clearToken())
      .finally(() => setChecking(false));
  }, []);

  const clearSession = useCallback(() => {
    clearToken();
    setSession(null);
    setJustSignedIn(false);
  }, []);

  // 主动退出：先告诉服务端，别人才会立刻看到离线；接口失败也不能卡住本地退出，
  // 那种情况仍由 90 秒的心跳窗口兜底。
  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* 断网或服务端不可达：本地照样退出 */
    } finally {
      clearSession();
    }
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
          onSignedIn={(user, ai) => {
            setSession({ user, ai });
            setJustSignedIn(true);
          }}
        />
      </div>
    );
  }

  return (
    <AppShell
      me={session.user}
      ai={session.ai}
      theme={theme}
      onToggleTheme={toggle}
      onSignOut={signOut}
      justSignedIn={justSignedIn}
    />
  );
}
