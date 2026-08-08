/**
 * ログイン済み画面（M2 ではプレースホルダ）。
 *
 * ヘッダーにログイン中のユーザー名とログアウト導線を表示する。
 * Vault 一覧・ファイルツリーは M3 でこの画面に実装される。
 */

export interface SignedInScreenProps {
  login: string;
  loggingOut: boolean;
  onLogout: () => void;
}

export function SignedInScreen({ login, loggingOut, onLogout }: SignedInScreenProps) {
  return (
    <>
      <header className="app-header">
        <h1>tektite</h1>
        <div className="session-controls">
          <span className="session-login">{login} でログイン中</span>
          <button
            type="button"
            className="button-secondary"
            onClick={onLogout}
            disabled={loggingOut}
          >
            {loggingOut ? 'ログアウト中…' : 'ログアウト'}
          </button>
        </div>
      </header>
      <p className="app-placeholder">Vault 選択画面は次のマイルストーン（M3）で実装されます。</p>
    </>
  );
}
