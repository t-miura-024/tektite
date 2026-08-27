/**
 * エラー値の生成と識別（class 宣言を使わない Error データ）。
 *
 * アプリケーション層のエラーは「Error インスタンスに name（と必要なら kind）
 * を載せたプレーンな値」として扱い、class の代わりにファクトリ関数と
 * 型ガードで生成・識別する。name による識別は構造化の単純さを保ち、
 * UI 層は型ガードで絞り込んだ上で kind / message を参照する。
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
