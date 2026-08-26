/**
 * API ルートハンドラ共通のコンテキスト型。
 *
 * Pages Functions（functions/）の onRequest コンテキストと同じ形に保ち、
 * ユニットテストからハンドラを直接呼べるようにする（ルーティングは
 * HonoX のファイルベースルーティングが担い、routes がこの型へ正規化して渡す）。
 */
export type RouteContext = {
  env: Env;
  request: Request;
  /** パスパラメータ（Hono は string。Pages Functions 互換で string[] も許容） */
  params: Record<string, string | string[]>;
};

/**
 * Hono のコンテキスト（c.env は unknown 型）を RouteContext へ正規化する。
 * フレームワーク境界の 1 箇所だけに型の確定を集約する。
 * @param env - Hono が実行時に渡す Workers の環境変数バインディング
 */
export function toRouteContext(
  env: unknown,
  request: Request,
  params: Record<string, string | string[]>,
): RouteContext {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Hono（フレームワーク）は c.env を unknown として提供するため、境界の 1 箇所でのみ Env への確定を許容する
  return { env: env as Env, request, params };
}
