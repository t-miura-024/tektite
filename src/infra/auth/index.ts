/**
 * 認証・セッションのインフラ層。
 *
 * - session-crypto / oauth-state / base64url / cookies:
 *   WebCrypto ベースの純 TS 実装。Pages Functions（functions/api/auth/**）と
 *   ユニットテストの両方から import される（Workers / ブラウザ / Node で動作）。
 * - session-gateway: ブラウザ側の SessionGateway 実装（Pages Functions 呼び出し）。
 */

export { base64UrlDecode, base64UrlEncode } from './base64url';
export { expireCookie, parseCookies, serializeCookie } from './cookies';
export type { CookieOptions, SameSite } from './cookies';
export { decryptSecretPayload, encryptSecretPayload } from './session-crypto';
export { HttpSessionGateway } from './session-gateway';
export { generateOAuthState, signOAuthState, verifyOAuthState } from './oauth-state';
