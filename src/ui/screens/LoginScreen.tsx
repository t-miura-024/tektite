/**
 * ログイン画面（未ログイン時の既定表示）。
 *
 * ログインはページ遷移（GET /api/auth/login → GitHub 認可ページへ 302）で進む。
 * トークンは Workers 側のみ保持され、ブラウザには暗号化 Cookie だけが残る（ADR-0002）。
 *
 * ディープリンク復帰: 現在のパスを `return_to` としてログイン URL に付与する。
 * コールバック後に署名検証の上で元パスへリダイレクトされる（functions/api/auth 参照）。
 */

/** ログイン開始 URL（ルート以外から開いた場合は return_to で現在パスを保持する） */
export function loginHref(pathname: string): string {
  if (pathname === '/' || pathname === '') {
    return '/api/auth/login';
  }
  return `/api/auth/login?return_to=${encodeURIComponent(pathname)}`;
}

export function LoginScreen() {
  return (
    <section className="login-card">
      <p className="login-tagline">GitHub リポジトリを Vault として使うマークダウンエディタ</p>
      <a className="button-primary login-button" href={loginHref(window.location.pathname)}>
        GitHub でログイン
      </a>
    </section>
  );
}
