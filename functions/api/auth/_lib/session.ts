/**
 * 認証 Cookie の発行/検証/削除。
 *
 * セッション状態は暗号化 Cookie のみ（ADR-0002）。OAuth の state も
 * 署名付き Cookie に保存し、サーバー側ストレージは一切使わない。
 * 暗号・署名の実体は src/infra/auth（WebCrypto・純 TS）を再利用する。
 */

// バレル（index）ではなく個別モジュールから import し、
// ブラウザ専用コード（session-gateway）を Workers バンドルに引き込まない。
import { expireCookie, parseCookies, serializeCookie } from '../../../../src/infra/auth/cookies';
import type { CookieOptions } from '../../../../src/infra/auth/cookies';
import { signOAuthState, verifyOAuthState } from '../../../../src/infra/auth/oauth-state';
import {
  decryptSecretPayload,
  encryptSecretPayload,
} from '../../../../src/infra/auth/session-crypto';

export const SESSION_COOKIE_NAME = 'tektite_session';
export const OAUTH_STATE_COOKIE_NAME = 'tektite_oauth_state';

/** セッション Cookie の寿命（30 日）。GitHub OAuth トークンは無期限 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
/** state Cookie の寿命（10 分）。認可操作の所要時間に合わせる */
const STATE_MAX_AGE_SECONDS = 600;

/** トークンは Workers 側のみ保持するため HttpOnly + Secure + SameSite=Lax 固定 */
const COOKIE_ATTRIBUTES: CookieOptions = {
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
};

/** アクセストークンを AES-GCM 暗号化してセッション Cookie を発行する */
export async function createSessionCookie(
  sessionSecret: string,
  accessToken: string,
): Promise<string> {
  const payload = await encryptSecretPayload(sessionSecret, accessToken);
  return serializeCookie(SESSION_COOKIE_NAME, payload, {
    ...COOKIE_ATTRIBUTES,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/** リクエストのセッション Cookie を復号し、アクセストークンを返す */
export async function readAccessToken(
  request: Request,
  sessionSecret: string,
): Promise<string | null> {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const payload = cookies[SESSION_COOKIE_NAME];
  if (!payload) {
    return null;
  }
  return decryptSecretPayload(sessionSecret, payload);
}

export function clearSessionCookie(): string {
  return expireCookie(SESSION_COOKIE_NAME, COOKIE_ATTRIBUTES);
}

/** state を HMAC 署名付き Cookie として発行する（CSRF 対策のステートレス保存） */
export async function createStateCookie(sessionSecret: string, state: string): Promise<string> {
  const signature = await signOAuthState(sessionSecret, state);
  return serializeCookie(OAUTH_STATE_COOKIE_NAME, `${state}.${signature}`, {
    ...COOKIE_ATTRIBUTES,
    maxAge: STATE_MAX_AGE_SECONDS,
  });
}

/**
 * コールバックの state クエリと署名付き state Cookie を突き合わせて検証する。
 * Cookie 欠落・state 不一致・署名不正のいずれも false。
 */
export async function verifyStateCookie(
  request: Request,
  sessionSecret: string,
  state: string,
): Promise<boolean> {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const value = cookies[OAUTH_STATE_COOKIE_NAME];
  if (!value) {
    return false;
  }
  const separatorIndex = value.lastIndexOf('.');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return false;
  }
  const cookieState = value.slice(0, separatorIndex);
  const signature = value.slice(separatorIndex + 1);
  if (cookieState !== state) {
    return false;
  }
  return verifyOAuthState(sessionSecret, cookieState, signature);
}

export function clearStateCookie(): string {
  return expireCookie(OAUTH_STATE_COOKIE_NAME, COOKIE_ATTRIBUTES);
}
