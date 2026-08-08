/**
 * アプリのシェル。セッション状態（M2）と URL ルーティング（M3）に応じて
 * 画面を切り替える。
 *
 * - 未ログイン      → LoginScreen（GitHub OAuth へ）
 * - ログイン済み    → ルートに応じて Vault 選択 / ファイルツリー / ノートパス
 * - 確認失敗        → エラー表示 + リトライ（エラー UX 基本方針）
 *
 * パスベースディープリンク（/:owner/:repo/blob/:path 系）に対応し、
 * リロードしても URL から状態を復元する（useRoute / parseRoute 参照）。
 *
 * OAuth コールバック後の `?error=<code>` はトーストで知らせ、URL から取り除く。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { SessionUser } from '@/application/session';
import { SessionFetchError, SessionUseCases } from '@/application/session';
import { VaultUseCases } from '@/application/vault';
import { HttpSessionGateway } from '@/infra/auth';
import { HttpVaultGateway } from '@/infra/github';

import { Link } from './components/Link';
import { Toast } from './components/Toast';
import { useRoute } from './router';
import { LoginScreen } from './screens/LoginScreen';
import { NotFoundScreen } from './screens/NotFoundScreen';
import { VaultPickerScreen } from './screens/VaultPickerScreen';
import { VaultScreen } from './screens/VaultScreen';
import type { ToastAction, ToastState } from './toast';

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
  const sessionUseCases = useMemo(() => new SessionUseCases(new HttpSessionGateway()), []);
  const vaultUseCases = useMemo(() => new VaultUseCases(new HttpVaultGateway()), []);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [toast, setToast] = useState<ToastState | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const route = useRoute();

  const checkSession = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      const session = await sessionUseCases.getCurrentSession();
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
  }, [sessionUseCases]);

  useEffect(() => {
    const oauthError = consumeOAuthErrorParam();
    if (oauthError) {
      setToast({ message: oauthError });
    }
    void checkSession();
  }, [checkSession]);

  const notify = useCallback((message: string, action?: ToastAction) => {
    setToast({ message, action });
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  const handleLogout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await sessionUseCases.logout();
      setPhase({ kind: 'anonymous' });
    } catch (error) {
      const message =
        error instanceof SessionFetchError ? error.message : 'ログアウトに失敗しました。';
      setToast({ message: `${message} 時間をおいてやり直してください。` });
    } finally {
      setLoggingOut(false);
    }
  }, [sessionUseCases]);

  const handleSessionExpired = useCallback(() => {
    void checkSession();
  }, [checkSession]);

  const toastAction = toast?.action;

  let authenticatedContent;
  switch (route.kind) {
    case 'vaults':
      authenticatedContent = (
        <VaultPickerScreen
          useCases={vaultUseCases}
          notify={notify}
          onSessionExpired={handleSessionExpired}
        />
      );
      break;
    case 'tree':
    case 'note':
      authenticatedContent = (
        <VaultScreen
          vaultRef={route.ref}
          notePath={route.kind === 'note' ? route.notePath : null}
          useCases={vaultUseCases}
          notify={notify}
          onSessionExpired={handleSessionExpired}
        />
      );
      break;
    case 'not-found':
      authenticatedContent = <NotFoundScreen />;
      break;
  }

  return (
    <main className="app-shell">
      {toast && (
        <Toast
          message={toast.message}
          onDismiss={dismissToast}
          action={
            toastAction
              ? {
                  label: toastAction.label,
                  onClick: () => {
                    setToast(null);
                    toastAction.onClick();
                  },
                }
              : undefined
          }
        />
      )}
      {phase.kind === 'authenticated' ? (
        <>
          <header className="app-header">
            <h1>
              <Link to="/" className="app-title-link">
                tektite
              </Link>
            </h1>
            <div className="session-controls">
              <span className="session-login">{phase.user.login} でログイン中</span>
              <button
                type="button"
                className="button-secondary"
                onClick={() => void handleLogout()}
                disabled={loggingOut}
              >
                {loggingOut ? 'ログアウト中…' : 'ログアウト'}
              </button>
            </div>
          </header>
          {authenticatedContent}
        </>
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
