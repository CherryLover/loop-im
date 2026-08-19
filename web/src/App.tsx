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

  const signOut = useCallback(() => {
    clearToken();
    setSession(null);
    setJustSignedIn(false);
  }, []);

  useEffect(() => {
    window.addEventListener('loop-im:signed-out', signOut);
    return () => window.removeEventListener('loop-im:signed-out', signOut);
  }, [signOut]);

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
