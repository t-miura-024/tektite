/**
 * ヘルスチェック: GET /api/health
 *
 * Pages Functions のデプロイ経路が正しく動いているかを検証する最小エンドポイント。
 * 認証系（M2）は functions/api/auth/**、Vault 系（M3）は functions/api/vaults/**・
 * functions/api/tree/** に追加される。
 */
export const onRequestGet: PagesFunction<Env, 'api/health'> = (context) => {
  // context（env バインディング・request・waitUntil など）は M2 以降で本格利用する雛形
  void context;
  return Response.json({ status: 'ok', service: 'tektite' });
};
