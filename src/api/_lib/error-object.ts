/**
 * エラー値の生成と識別（class 宣言を使わない Error データ）。
 *
 * name を載せた Error インスタンスをファクトリ関数で生成し、
 * 型ガード（isErrorNamed）で識別する。
 */

/**
 * name を持つ Error を生成する。cause は Error コンストラクター標準の
 * options 経由で設定する。
 */
export function makeNamedError(
  name: string,
  message: string,
  options?: { cause?: unknown },
): Error {
  const error = new Error(message, options);
  error.name = name;
  return error;
}

/** error が指定した name を持つ Error かどうか（型ガードの基礎） */
export function isErrorNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}
