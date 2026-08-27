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
 *
 * ユースケースの実行はすべて組成ルート（src/composition）の run() 経由で行う。
 * UI 層は infra 層を import しない（依存の向きは src/composition.ts 参照）。
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
    const oauthError = consumeOAuthErrorParam();
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
