/**
 * アプリのシェル。セッション状態（M2）に応じて画面を切り替える。
 *
 * - 未ログイン      → LoginScreen（GitHub OAuth へ）
 * - ログイン済み    → SignedInScreen（ログアウト導線付き。Vault 選択は M3）
 * - 確認失敗        → エラー表示 + リトライ（エラー UX 基本方針）
 *
 * OAuth コールバック後の `?error=<code>` はトーストで知らせ、URL から取り除く。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { SessionUser } from '@/application/session';
import { SessionFetchError, SessionUseCases } from '@/application/session';
import { HttpSessionGateway } from '@/infra/auth';

import { Toast } from './components/Toast';
import { LoginScreen } from './screens/LoginScreen';
import { SignedInScreen } from './screens/SignedInScreen';

type Phase =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; user: SessionUser }
  | { kind: 'error'; message: string };

/** コールバックのリダイレクトに付与されるエラーコード → 表示メッセージ */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_state: 'GitHub 認証の state が一致しませんでした。最初からログインし直してください。',
  oauth_denied: 'GitHub での認証がキャンセルされました。',
  oauth_exchange: 'GitHub トークンの取得に失敗しました。時間をおいて再度ログインしてください。',
};

function consumeOAuthErrorParam(): string | null {
  const params = new URLSearchParams(window.location.search);
  const errorCode = params.get('error');
  if (!errorCode) {
    return null;
  }
  params.delete('error');
  const query = params.toString();
  window.history.replaceState(null, '', query ? `/?${query}` : '/');
  return (
    OAUTH_ERROR_MESSAGES[errorCode] ?? '認証中にエラーが発生しました。ログインし直してください。'
  );
}

export function App() {
  const useCases = useMemo(() => new SessionUseCases(new HttpSessionGateway()), []);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [toast, setToast] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const checkSession = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      const session = await useCases.getCurrentSession();
      if (session.status === 'authenticated') {
        setPhase({ kind: 'authenticated', user: session.user });
      } else {
        setPhase({ kind: 'anonymous' });
      }
    } catch (error) {
      const message =
        error instanceof SessionFetchError ? error.message : 'セッションの確認に失敗しました。';
      setPhase({ kind: 'error', message });
    }
  }, [useCases]);

  useEffect(() => {
    const oauthError = consumeOAuthErrorParam();
    if (oauthError) {
      setToast(oauthError);
    }
    void checkSession();
  }, [checkSession]);

  const handleLogout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await useCases.logout();
      setPhase({ kind: 'anonymous' });
    } catch (error) {
      const message =
        error instanceof SessionFetchError ? error.message : 'ログアウトに失敗しました。';
      setToast(`${message} 時間をおいてやり直してください。`);
    } finally {
      setLoggingOut(false);
    }
  }, [useCases]);

  return (
    <main className="app-shell">
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
      {phase.kind === 'authenticated' ? (
        <SignedInScreen login={phase.user.login} loggingOut={loggingOut} onLogout={handleLogout} />
      ) : (
        <>
          <header className="app-header">
            <h1>tektite</h1>
          </header>
          {phase.kind === 'loading' && (
            <p className="app-placeholder" role="status">
              セッションを確認中…
            </p>
          )}
          {phase.kind === 'anonymous' && <LoginScreen />}
          {phase.kind === 'error' && (
            <section className="error-panel">
              <p role="alert">{phase.message}</p>
              <button
                type="button"
                className="button-secondary"
                onClick={() => void checkSession()}
              >
                再試行
              </button>
            </section>
          )}
        </>
      )}
    </main>
  );
}
