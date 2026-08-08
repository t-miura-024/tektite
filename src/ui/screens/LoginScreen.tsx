/**
 * ログイン画面（未ログイン時の既定表示）。
 *
 * ログインはページ遷移（GET /api/auth/login → GitHub 認可ページへ 302）で進む。
 * トークンは Workers 側のみ保持され、ブラウザには暗号化 Cookie だけが残る（ADR-0002）。
 */

export function LoginScreen() {
  return (
    <section className="login-card">
      <p className="login-tagline">GitHub リポジトリを Vault として使うマークダウンエディタ</p>
      <a className="button-primary login-button" href="/api/auth/login">
        GitHub でログイン
      </a>
    </section>
  );
}
