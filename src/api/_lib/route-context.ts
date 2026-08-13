/**
 * API ルートハンドラ共通のコンテキスト型。
 *
 * Pages Functions（functions/）の onRequest コンテキストと同じ形に保ち、
 * ユニットテストからハンドラを直接呼べるようにする（ルーティングは
 * HonoX のファイルベースルーティングが担い、routes がこの型へ正規化して渡す）。
 */
export interface RouteContext {
  env: Env;
  request: Request;
  /** パスパラメータ（Hono は string。Pages Functions 互換で string[] も許容） */
  params: Record<string, string | string[]>;
}
