/**
 * サーバー側トークンストア（KV）。Cron用にトークンペアをAES-GCM暗号化して保存する。
 * 保存はcallback時にwrite権限とログイン名の確認を伴い、期限切れは自動延長する。
 * 延長時はローテーションされた新ペアを保存し直し、未保存や復号失敗はnullで返す。
 * KV未設定でも実行は通り保持だけが無効になり、Cookieフローは従来通り動く。
 */

import { isErrorNamed, makeNamedError } from '@/api/_lib/error-object';
import { decryptSecretPayload, encryptSecretPayload } from '@/domain/auth/session-crypto';
import type { AuthConfig } from '@/api/_lib/env';
import { githubApiFetch } from '@/api/_lib/github-proxy';

/** KV に保存するトークンペア（保存対象はアクセストークン + リフレッシュトークンの最小限） */
export type StoredTokenPair = {
  accessToken: string;
  /** GitHub が refresh_token を発行しない従来型トークンの場合は undefined */
  refreshToken?: string;
  /** アクセストークンの有効期限（epoch ms）。GitHub が expires_in を返さない場合は無期限 */
  expiresAt?: number;
};

const KV_KEY_PREFIX = 'token:';

export function tokenKeyForLogin(login: string): string {
  return `${KV_KEY_PREFIX}${login}`;
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
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'accessToken' in parsed &&
      typeof parsed.accessToken === 'string' &&
      (!('refreshToken' in parsed) ||
        parsed.refreshToken === undefined ||
        typeof parsed.refreshToken === 'string') &&
      (!('expiresAt' in parsed) ||
        parsed.expiresAt === undefined ||
        typeof parsed.expiresAt === 'number')
    ) {
      return {
        accessToken: parsed.accessToken,
        refreshToken:
          'refreshToken' in parsed && typeof parsed.refreshToken === 'string'
            ? parsed.refreshToken
            : undefined,
        expiresAt:
          'expiresAt' in parsed && typeof parsed.expiresAt === 'number'
            ? parsed.expiresAt
            : undefined,
      };
    }
    return null;
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
export type OAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

/** トークンリフレッシュの失敗（network / invalid_grant） */
export type TokenRefreshError = Error;

/** TokenRefreshError を生成するファクトリ */
export function tokenRefreshError(reason: string): TokenRefreshError {
  return makeNamedError('TokenRefreshError', reason);
}

/** error が TokenRefreshError かどうか */
export function isTokenRefreshError(error: unknown): error is TokenRefreshError {
  return isErrorNamed(error, 'TokenRefreshError');
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
    throw tokenRefreshError('network');
  }
  const body: unknown = await response.json().catch(() => null);
  const accessToken =
    typeof body === 'object' && body !== null && 'access_token' in body
      ? body.access_token
      : undefined;
  if (!response.ok || typeof accessToken !== 'string') {
    // 無効・失効済みの refresh token（GitHub は 200 + { error } または 4xx で返す）
    throw tokenRefreshError('invalid_grant');
  }
  const refreshTokenValue =
    typeof body === 'object' &&
    body !== null &&
    'refresh_token' in body &&
    typeof body.refresh_token === 'string'
      ? body.refresh_token
      : undefined;
  const expiresIn =
    typeof body === 'object' &&
    body !== null &&
    'expires_in' in body &&
    typeof body.expires_in === 'number'
      ? body.expires_in
      : undefined;
  return {
    accessToken,
    refreshToken: refreshTokenValue,
    expiresAt: expiresIn === undefined ? undefined : Date.now() + expiresIn * 1000,
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

/** callback時にKVへ保存する。条件外は保存せず継続する。 */
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
  const user: unknown = await userResponse.json().catch(() => null);
  const login =
    typeof user === 'object' && user !== null && 'login' in user && typeof user.login === 'string'
      ? user.login
      : null;
  if (login === null || login.length === 0) {
    return false;
  }
  await saveTokenPair(kv, config.sessionSecret, login, {
    accessToken: tokenBody.access_token ?? '',
    refreshToken: tokenBody.refresh_token,
    expiresAt:
      typeof tokenBody.expires_in === 'number'
        ? Date.now() + tokenBody.expires_in * 1000
        : undefined,
  });
  return true;
}
