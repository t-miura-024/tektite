/**
 * アプリのシェル。セッション状態と URL ルーティングに応じて画面を切り替える。未ログインは
 * ログイン画面、ログイン済みはルート別の Vault 選択やツリー表示とし、確認失敗は再試行付きで
 * 示す。深いリンクは再読込で復元し、OAuth コールバックのエラーはトーストで知らせて URL から
 * 除去する。実行は組成ルート経由とする。
 */

import { useCallback, useEffect, useState, type JSX } from 'react';

import { Link } from '@/ui/components/link';
import { Toast } from '@/ui/components/toast';
import { routeContent } from '@/ui/route-content';
import { useRoute } from '@/ui/router';
import { SessionControls } from '@/ui/session-controls';
import type { ToastAction, ToastState } from '@/ui/toast';
import { UnauthenticatedView } from '@/ui/unauthenticated-view';
import { useAppSession } from '@/ui/use-app-session';

/** コールバックのリダイレクトに付与されるエラーコード → 表示メッセージ */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_state: 'GitHub 認証の state が一致しませんでした。最初からログインし直してください。',
  oauth_denied: 'GitHub での認証がキャンセルされました。',
  oauth_exchange: 'GitHub トークンの取得に失敗しました。時間をおいて再度ログインしてください。',
};

export function App(): JSX.Element {
  const [toast, setToast] = useState<ToastState | null>(null);
  const notify = useCallback((message: string, action?: ToastAction): void => {
    setToast({ message, action });
  }, []);
  const { phase, checkSession, handleLogout, loggingOut } = useAppSession(notify);
  const route = useRoute();

  const dismissToast = useCallback((): void => setToast(null), []);
  const handleSessionExpired = useCallback((): void => {
    void checkSession();
  }, [checkSession]);

  // OAuth コールバック後の ?error= をトーストへ出し、初期セッション確認を行う
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errorCode = params.get('error');
    let oauthError: string | null = null;
    if (errorCode) {
      params.delete('error');
      const query = params.toString();
      window.history.replaceState(null, '', query ? `/?${query}` : '/');
      oauthError =
        OAUTH_ERROR_MESSAGES[errorCode] ??
        '認証中にエラーが発生しました。ログインし直してください。';
    }
    if (oauthError) {
      setToast({ message: oauthError });
    }
    void checkSession();
  }, [checkSession]);

  const toastAction = toast?.action;

  return (
    <main
      className={`app-shell${route.kind === 'tree' || route.kind === 'note' ? ' vault-workspace-shell' : ''}`}
    >
      {toast && (
        <Toast
          message={toast.message}
          onDismiss={dismissToast}
          action={
            toastAction
              ? {
                  label: toastAction.label,
                  onClick: (): void => {
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
            <SessionControls
              login={phase.user.login}
              loggingOut={loggingOut}
              onLogout={() => void handleLogout()}
            />
          </header>
          {routeContent(route, { notify, onSessionExpired: handleSessionExpired })}
        </>
      ) : (
        <>
          <header className="app-header">
            <h1>tektite</h1>
          </header>
          <UnauthenticatedView phase={phase} onRetry={() => void checkSession()} />
        </>
      )}
    </main>
  );
}
