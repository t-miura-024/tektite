/**
 * Cloudflare Pages Functions の環境バインディング定義。
 *
 * 本番/プレビューでは wrangler（vars / secrets）または Cloudflare ダッシュボードで設定する。
 * ローカル開発では `.dev.vars`（gitignore 済み）に同じキーで設定する。
 * テンプレートは `.dev.vars.example` を参照。
 */
interface Env {
  /** OAuth App の client ID（vars） */
  GITHUB_CLIENT_ID?: string;
  /** OAuth App の client secret（secret） */
  GITHUB_CLIENT_SECRET?: string;
  /** AES-GCM 暗号化 Cookie の鍵（secret） */
  SESSION_SECRET?: string;
  /** OAuth コールバック URL（vars。例: https://tektite.pages.dev/api/auth/callback） */
  OAUTH_REDIRECT_URI?: string;

  /**
   * PAT モード有効化フラグ（vars。ローカル開発専用）。
   * この値が "true" かつ GITHUB_PERSONAL_TOKEN が設定されている時のみ PAT モードが有効になり、
   * OAuth 4 変数（GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / SESSION_SECRET / OAUTH_REDIRECT_URI）を
   * 一切必要としない（PAT 優先: セッション Cookie は無視される）。
   */
  TEKTITE_PAT_AUTH?: string;
  /** PAT モードで GitHub API を呼び出すための個人アクセストークン（secret。ローカル開発専用） */
  GITHUB_PERSONAL_TOKEN?: string;

  /**
   * テストシーム: サーバー側トークン交換のエンドポイント。
   * 既定は GitHub 本番。E2E ではローカルモックに差し替える
   * （ブラウザが訪れる認可ページは常に github.com を使い、Playwright route でモックする）。
   */
  GITHUB_TOKEN_URL?: string;
  /** テストシーム: サーバー側 GitHub API のベース URL。既定は https://api.github.com */
  GITHUB_API_BASE_URL?: string;
}
