/**
 * base64url（RFC 4648 §5）のエンコード/デコード。
 *
 * Cookie 値や暗号ペイロードを URL・Cookie 安全な文字列として扱うための補助。
 * ブラウザ・Workers・Node（テスト）のいずれにも存在する btoa / atob のみを使い、
 * プラットフォーム固有 API（Buffer など）には依存しない。
 */

import { err, ok } from '@/domain/result';
import type { Result } from '@/domain/result';

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** base64url デコードの失敗理由 */
export type Base64UrlDecodeError = 'invalid_base64url';

/**
 * base64url 文字列をデコードする。不正な入力の場合は Err を返す。
 * WebCrypto（BufferSource）にそのまま渡せるよう ArrayBuffer 基底を明示する。
 */
export function base64UrlDecode(
  input: string,
): Result<Uint8Array<ArrayBuffer>, Base64UrlDecodeError> {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) {
    return err('invalid_base64url');
  }
  const base64 = input.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return ok(bytes);
  } catch {
    return err('invalid_base64url');
  }
}
