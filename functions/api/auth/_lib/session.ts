/**
 * 認証 Cookie の発行/検証/削除。
 *
 * セッション状態は暗号化 Cookie のみ（ADR-0002）。OAuth の state も
 * 署名付き Cookie に保存し、サーバー側ストレージは一切使わない。
 * 暗号・署名の実体は src/infra/auth（WebCrypto・純 TS）を再利用する。
 */

// バレル（index）ではなく個別モジュールから import し、
// ブラウザ専用コード（session-gateway）を Workers バンドルに引き込まない。
import { expireCookie, parseCookies, serializeCookie } from '@/infra/auth/cookies';
import type { CookieOptions } from '@/infra/auth/cookies';
import { signOAuthState, verifyOAuthState } from '@/infra/auth/oauth-state';
import { decryptSecretPayload, encryptSecretPayload } from '@/infra/auth/session-crypto';

export const SESSION_COOKIE_NAME = 'tektite_session';
export const OAUTH_STATE_COOKIE_NAME = 'tektite_oauth_state';
export const RETURN_TO_COOKIE_NAME = 'tektite_return_to';

/** セッション Cookie の寿命（30 日）。GitHub OAuth トークンは無期限 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
/** state Cookie の寿命（10 分）。認可操作の所要時間に合わせる */
const STATE_MAX_AGE_SECONDS = 600;
/** return-to Cookie の寿命（10 分）。state と同じ認可操作の時間軸に合わせる */
const RETURN_TO_MAX_AGE_SECONDS = 600;
/** return-to の最大長。これを超えるパスは "/" として扱う（Cookie 尺寸制限の防衛線） */
const RETURN_TO_MAX_LENGTH = 2048;

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

/**
 * ログイン後に戻すパス（return-to）として安全な同一オリジン絶対パスか。
 * オープンリダイレクトとヘッダーインジェクションの防衛線:
 * - `/` 始まりのみ（スキーム付き URL や `//example.com` 等のプロトコル相対を拒否）
 * - バックスラッシュを拒否（一部のブラウザが `/` と同等に正規化する対策）
 * - 改行を拒否（Location ヘッダーへの注入対策）
 */
export function isSafeReturnTo(path: string): boolean {
  if (path.length === 0 || path.length > RETURN_TO_MAX_LENGTH) {
    return false;
  }
  if (!path.startsWith('/') || path.startsWith('//')) {
    return false;
  }
  if (path.includes('\\') || path.includes('\r') || path.includes('\n')) {
    return false;
  }
  return true;
}

/**
 * return-to を HMAC 署名付き Cookie として発行する（state と同じステートレス保存）。
 * 署名により、コールバック時のリダイレクト先改ざんを防ぐ。
 */
export async function createReturnToCookie(
  sessionSecret: string,
  returnTo: string,
): Promise<string> {
  const signature = await signOAuthState(sessionSecret, returnTo);
  return serializeCookie(RETURN_TO_COOKIE_NAME, `${returnTo}.${signature}`, {
    ...COOKIE_ATTRIBUTES,
    maxAge: RETURN_TO_MAX_AGE_SECONDS,
  });
}

/**
 * 署名付き return-to Cookie を検証し、ログイン後の戻り先パスを返す。
 * Cookie 欠落・署名不正・安全でないパスのいずれも "/" に落ち着く。
 */
export async function verifyReturnToCookie(
  request: Request,
  sessionSecret: string,
): Promise<string> {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const value = cookies[RETURN_TO_COOKIE_NAME];
  if (!value) {
    return '/';
  }
  const separatorIndex = value.lastIndexOf('.');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return '/';
  }
  const returnTo = value.slice(0, separatorIndex);
  const signature = value.slice(separatorIndex + 1);
  if (!isSafeReturnTo(returnTo)) {
    return '/';
  }
  const valid = await verifyOAuthState(sessionSecret, returnTo, signature);
  return valid ? returnTo : '/';
}

export function clearReturnToCookie(): string {
  return expireCookie(RETURN_TO_COOKIE_NAME, COOKIE_ATTRIBUTES);
}
