/**
 * コンテンツハッシュ（M4: 書き込み経路の R2 先行化）。
 *
 * 保存時の楽観ロックは GitHub の blob sha ではなく、R2 上のコンテンツ
 * ハッシュ（SHA-256）で照合する（完了条件 8）。同一本文からは常に同一の
 * ハッシュが得られるため、同期済みノート（GitHub blob sha 保持）とローカル
 * 保存ノート（SHA-256）が混在しても、読み取り → 編集 → 保存の一連の流れでは
 * 一貫した楽観ロックとして機能する。
 *
 * Workers ランタイム（および Node のテスト環境）の Web Crypto API を使用する。
 */

/** UTF-8 本文の SHA-256 ハッシュを 16 進文字列で返す */
export async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
