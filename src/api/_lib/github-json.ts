/**
 * GitHub API 応答（JSON）の安全な読み取り。
 *
 * 応答ボディを unknown のまま受け、型アサーションを使わずに
 * フィールドを読むための最小ユーティリティ。形式不正は null に倒す。
 */

/** レコード（オブジェクト）かどうか。フィールド読み取りの入口 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 応答ボディを JSON として読む（パース失敗は null） */
export function readJsonBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

/** オブジェクトフィールドを読む（存在しない場合は undefined） */
export function readField(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}

/** 文字列フィールドを読む（存在しない・型不一致は null） */
export function readStringField(source: unknown, key: string): string | null {
  const value = readField(source, key);
  return typeof value === 'string' ? value : null;
}

/** 空でない文字列フィールドを読む（空文字・欠落は null） */
export function readNonEmptyStringField(source: unknown, key: string): string | null {
  const value = readStringField(source, key);
  return value !== null && value.length > 0 ? value : null;
}
