/**
 * 認証エンドポイントの環境変数解決。
 *
 * 資格情報（client_id / client_secret / SESSION_SECRET / OAUTH_REDIRECT_URI）は
 * wrangler の vars / secrets（ローカルは .dev.vars）から読む。未設定でも
 * ビルド・テストは通り、実行時は明確なエラーを返す。
 */

/** ブラウザが訪れる GitHub の認可ページ（OAuth App フロー固定） */
export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

const DEFAULT_GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  redirectUri: string;
  /** サーバー側トークン交換エンドポイント（E2E でモック差し替え可能） */
  tokenUrl: string;
  /** サーバー側 GitHub API ベース URL（E2E でモック差し替え可能） */
  apiBaseUrl: string;
}

export function resolveAuthConfig(env: Env): AuthConfig {
  if (!env.GITHUB_CLIENT_ID) {
    throw new AuthConfigError('環境変数 GITHUB_CLIENT_ID が設定されていません');
  }
  if (!env.GITHUB_CLIENT_SECRET) {
    throw new AuthConfigError('環境変数 GITHUB_CLIENT_SECRET が設定されていません');
  }
  if (!env.SESSION_SECRET) {
    throw new AuthConfigError('環境変数 SESSION_SECRET が設定されていません');
  }
  if (!env.OAUTH_REDIRECT_URI) {
    throw new AuthConfigError('環境変数 OAUTH_REDIRECT_URI が設定されていません');
  }
  return {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    sessionSecret: env.SESSION_SECRET,
    redirectUri: env.OAUTH_REDIRECT_URI,
    tokenUrl: env.GITHUB_TOKEN_URL ?? DEFAULT_GITHUB_TOKEN_URL,
    apiBaseUrl: env.GITHUB_API_BASE_URL ?? DEFAULT_GITHUB_API_BASE_URL,
  };
}
