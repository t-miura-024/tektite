/**
 * セッション Cookie 用の AES-GCM 暗号化（ADR-0002）。
 *
 * GitHub のアクセストークンを Workers シークレット（SESSION_SECRET）由来の鍵で
 * 暗号化し、HttpOnly Cookie に格納するためのペイロードを生成/復号する。
 * サーバー側ストレージ（KV / D1）は使わず、暗号化 Cookie が唯一のセッション状態。
 *
 * ペイロード形式: `v1.<base64url(iv)>.<base64url(ciphertext)>`
 * - 鍵は SESSION_SECRET の SHA-256 ダイジェストから AES-GCM 256 鍵を導出
 * - iv は 12 バイトの乱数を暗号化ごとに生成
 *
 * WebCrypto（crypto.subtle）のみを使用し、Node API には依存しない
 * （Workers ランタイム・ブラウザ・Vitest(node) のいずれでも動作する）。
 */

import { base64UrlDecode, base64UrlEncode } from '@/infra/auth/base64url';
import { err, ok } from '@/domain/result';
import type { Result } from '@/domain/result';

const PAYLOAD_VERSION = 'v1';
const IV_BYTES = 12;

async function deriveAesGcmKey(secret: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * プレインテキストを暗号化ペイロード文字列に変換する。
 */
export async function encryptSecretPayload(secret: string, plaintext: string): Promise<string> {
  const key = await deriveAesGcmKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${PAYLOAD_VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

/**
 * 復号の失敗理由: ペイロード形式・鍵・改ざんのどの段階で失敗したか。
 * - invalid_format: 形式不正（バージョン不一致・iv/暗号文の欠落・base64url 不正・長さ不正）
 * - decrypt_failed: 鍵不一致・改ざん（AES-GCM の認証タグ検証失敗）
 */
export type SessionDecryptError = 'invalid_format' | 'decrypt_failed';

/**
 * 暗号化ペイロードを復号する。成功時は平文、失敗時は失敗理由を Result で返す。
 * 呼び出し側は Err を「トークンなし」として扱う（未ログインと区別しない）。
 */
export async function decryptSecretPayload(
  secret: string,
  payload: string,
): Promise<Result<string, SessionDecryptError>> {
  const parts = payload.split('.');
  if (parts.length !== 3 || parts[0] !== PAYLOAD_VERSION) {
    return err('invalid_format');
  }
  const ivPart = parts[1];
  const ciphertextPart = parts[2];
  if (!ivPart || !ciphertextPart) {
    return err('invalid_format');
  }
  const iv = base64UrlDecode(ivPart);
  const ciphertext = base64UrlDecode(ciphertextPart);
  if (!iv.ok || !ciphertext.ok) {
    return err('invalid_format');
  }
  if (iv.value.byteLength !== IV_BYTES || ciphertext.value.byteLength === 0) {
    return err('invalid_format');
  }
  try {
    const key = await deriveAesGcmKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.value },
      key,
      ciphertext.value,
    );
    return ok(new TextDecoder().decode(plaintext));
  } catch {
    return err('decrypt_failed');
  }
}
