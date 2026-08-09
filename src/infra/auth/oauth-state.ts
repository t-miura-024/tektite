/**
 * OAuth の state パラメータ生成と HMAC-SHA-256 署名（CSRF 対策）。
 *
 * state の保存はサーバー側ストレージを持たず（ADR-0002）、署名付き HttpOnly
 * Cookie に格納する。コールバック時に署名を検証（crypto.subtle.verify による
 * タイミングセーフ比較）してから state を突き合わせる。
 *
 * WebCrypto（crypto.subtle）のみを使用し、Node API には依存しない。
 */

import { base64UrlDecode, base64UrlEncode } from '@/infra/auth/base64url';

const STATE_BYTES = 32;

/**
 * 推測不可能なランダムな state 値を生成する。
 */
export function generateOAuthState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(STATE_BYTES)));
}

async function importHmacKey(secret: string, usages: CryptoKey['usages']): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

/**
 * state を SESSION_SECRET で署名し、base64url 署名文字列を返す。
 */
export async function signOAuthState(secret: string, state: string): Promise<string> {
  const key = await importHmacKey(secret, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(state));
  return base64UrlEncode(new Uint8Array(signature));
}

/**
 * state と署名の組を検証する。不正な場合は false。
 */
export async function verifyOAuthState(
  secret: string,
  state: string,
  signature: string,
): Promise<boolean> {
  const signatureBytes = base64UrlDecode(signature);
  if (!signatureBytes.ok || signatureBytes.value.byteLength === 0 || state.length === 0) {
    return false;
  }
  try {
    const key = await importHmacKey(secret, ['verify']);
    return await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes.value,
      new TextEncoder().encode(state),
    );
  } catch {
    return false;
  }
}
