/**
 * 成功または失敗を表す最小の Result 型（純 TS・フレームワーク非依存）。
 *
 * 値の解釈に失敗しうる処理（Cookie のパース、base64url デコード、復号など）が、
 * null や例外ではなく型として失敗を表現するために使う。domain 層に置くことで
 * src と functions のどちらからでも依存できる。
 *
 * 使い分けの目安:
 * - 値の生成が失敗しうる「解釈」には Result を使う（失敗理由が呼び出し側で
 *   無視されるかどうかは呼び出し側が決める）
 * - 全体の成否だけでよい検証（署名一致など）は従来どおり boolean でよい
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** 成功値を持つ Result を作る */
export function ok<T, E>(value: T): Result<T, E> {
  return { ok: true, value };
}

/** 失敗理由を持つ Result を作る */
export function err<T, E>(error: E): Result<T, E> {
  return { ok: false, error };
}

/** 失敗時に既定値を返す（成功時は値をそのまま返す） */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
