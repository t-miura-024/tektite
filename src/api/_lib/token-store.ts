/**
 * サーバー側トークンストア（KV、ADR-0007）。
 *
 * Cron 同期（M5）はユーザー Cookie を持てないため、GitHub OAuth の
 * アクセストークン + リフレッシュトークンを KV に AES-GCM 暗号化して保存し、
 * 期限切れ時はリフレッシュトークンで自動延長する（ADR-0007）。
 * 暗号化は session-crypto（ADR-0002 の AES-GCM 方式）を再利用する。
 *
 * - 保存: ログイン callback 時。write 権限（scope に repo）と /user での
 *   ログイン名解決を保存時に確認し、以降の同期では確認しない
 * - 読み出し: アクセストークンが期限切れなら refresh して保存し直す。
 *   GitHub は refresh のたびに新しい access_token / refresh_token を返す
 *   （refresh token はローテーションされる）
 * - KV 未設定（TOKEN_KV バインディングなし）でもビルド・実行は通り、
 *   その環境ではサーバー側トークン保持が無効になる（Cookie フローは従来通り）
 */

import { decryptSecretPayload, encryptSecretPayload } from '@/infra/auth/session-crypto';
import type { AuthConfig } from '@/api/_lib/env';
import { githubApiFetch } from '@/api/_lib/github-proxy';

/** KV に保存するトークンペア（保存対象はアクセストークン + リフレッシュトークンの最小限） */
export interface StoredTokenPair {
  accessToken: string;
  /** GitHub が refresh_token を発行しない従来型トークンの場合は undefined */
  refreshToken?: string;
  /** アクセストークンの有効期限（epoch ms）。GitHub が expires_in を返さない場合は無期限 */
  expiresAt?: number;
}

const KV_KEY_PREFIX = 'token:';

export function tokenKeyForLogin(login: string): string {
  return `${KV_KEY_PREFIX}${login}`;
}

function isStoredTokenPair(value: unknown): value is StoredTokenPair {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.accessToken === 'string' &&
    (candidate.refreshToken === undefined || typeof candidate.refreshToken === 'string') &&
    (candidate.expiresAt === undefined || typeof candidate.expiresAt === 'number')
  );
}

/** トークンペアを AES-GCM 暗号化して KV に保存する（login 単位。上書きは最新トークン優先） */
export async function saveTokenPair(
  kv: KVNamespace,
  sessionSecret: string,
  login: string,
  pair: StoredTokenPair,
): Promise<void> {
  const payload = await encryptSecretPayload(sessionSecret, JSON.stringify(pair));
  await kv.put(tokenKeyForLogin(login), payload);
}

/** KV からトークンペアを復号して返す。未保存・復号失敗（鍵不一致・改ざん）は null */
export async function readTokenPair(
  kv: KVNamespace,
  sessionSecret: string,
  login: string,
): Promise<StoredTokenPair | null> {
  const payload = await kv.get(tokenKeyForLogin(login));
  if (payload === null) {
    return null;
  }
  const decrypted = await decryptSecretPayload(sessionSecret, payload);
  if (!decrypted.ok) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(decrypted.value);
    return isStoredTokenPair(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function deleteTokenPair(kv: KVNamespace, login: string): Promise<void> {
  await kv.delete(tokenKeyForLogin(login));
}

/**
 * アクセストークンの期限切れ判定。
 * expiresAt 未定義（GitHub が expires_in を返さない無期限トークン）は期限切れとしない。
 */
export function isAccessTokenExpired(pair: StoredTokenPair, now: number): boolean {
  return pair.expiresAt !== undefined && pair.expiresAt <= now;
}

/** トークン交換（callback）レスポンスのうち保存に使うフィールド */
export interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export class TokenRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenRefreshError';
  }
}

/**
 * リフレッシュトークンでアクセストークンを自動延長する。
 * リクエストはトークン交換と同じエンドポイント（config.tokenUrl）で
 * grant_type=refresh_token を使う。GitHub は新しい access_token /
 * refresh_token（ローテーション）/ expires_in を返す。
 */
export async function refreshOAuthToken(
  config: AuthConfig,
  refreshToken: string,
): Promise<StoredTokenPair> {
  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'tektite',
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
  } catch {
    throw new TokenRefreshError('network');
  }
  const body = (await response.json().catch(() => null)) as OAuthTokenResponse | null;
  if (!response.ok || !body || typeof body.access_token !== 'string') {
    // 無効・失効済みの refresh token（GitHub は 200 + { error } または 4xx で返す）
    throw new TokenRefreshError('invalid_grant');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt:
      typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : undefined,
  };
}

export type ServerAccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'kv_missing' | 'no_token' | 'no_refresh_token' | 'refresh_failed' };

/**
 * ユーザー Cookie なしでアクセストークンを取得する（Cron 同期用）。
 * 期限切れならリフレッシュトークンで自動延長し、延長結果を KV に保存し直す。
 * 取得失敗は reason で区別し、呼び出し側（M5 の定時同期）が Vault 単位で記録する。
 */
export async function getServerAccessToken(
  env: Env,
  config: AuthConfig,
  login: string,
  now: number = Date.now(),
): Promise<ServerAccessTokenResult> {
  const kv = env.TOKEN_KV;
  if (!kv) {
    return { ok: false, reason: 'kv_missing' };
  }
  const pair = await readTokenPair(kv, config.sessionSecret, login);
  if (!pair) {
    return { ok: false, reason: 'no_token' };
  }
  if (!isAccessTokenExpired(pair, now)) {
    return { ok: true, accessToken: pair.accessToken };
  }
  if (!pair.refreshToken) {
    return { ok: false, reason: 'no_refresh_token' };
  }
  let refreshed: StoredTokenPair;
  try {
    refreshed = await refreshOAuthToken(config, pair.refreshToken);
  } catch {
    return { ok: false, reason: 'refresh_failed' };
  }
  await saveTokenPair(kv, config.sessionSecret, login, refreshed);
  return { ok: true, accessToken: refreshed.accessToken };
}

/**
 * ログイン callback 時にトークンペアを KV へ暗号化保存する。
 *
 * 保存条件（方針 6: write 権限は保存時に確認し、以降は確認しない）:
 * 1. KV バインディングが設定されている
 * 2. トークンに write 権限がある（OAuth scope に repo が含まれる）
 * 3. /user でログイン名が解決できる（KV キーが login 単位のため）
 *
 * いずれかを満たさない場合は保存せず false を返す（ログイン自体は
 * Cookie フローで継続し、既存挙動を壊さない）。
 */
export async function persistOAuthTokenPair(
  env: Env,
  config: AuthConfig,
  tokenBody: OAuthTokenResponse,
): Promise<boolean> {
  const kv = env.TOKEN_KV;
  if (!kv) {
    return false;
  }
  if (typeof tokenBody.access_token !== 'string') {
    return false;
  }
  // write 権限確認: OAuth App は scope=repo で認可を要求する（login.ts）。
  // 付与された scope に repo が含まれないトークンは保存しない
  if (!tokenBody.scope?.split(/\s+/).includes('repo')) {
    return false;
  }
  const userResponse = await githubApiFetch(config.apiBaseUrl, '/user', tokenBody.access_token);
  if (!userResponse.ok) {
    return false;
  }
  const user = (await userResponse.json().catch(() => null)) as { login?: unknown } | null;
  if (!user || typeof user.login !== 'string' || user.login.length === 0) {
    return false;
  }
  await saveTokenPair(kv, config.sessionSecret, user.login, {
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token,
    expiresAt:
      typeof tokenBody.expires_in === 'number'
        ? Date.now() + tokenBody.expires_in * 1000
        : undefined,
  });
  return true;
}
