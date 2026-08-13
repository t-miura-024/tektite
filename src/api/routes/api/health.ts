/**
 * ヘルスチェック: GET /api/health
 *
 * Workers デプロイ経路が正しく動いているかを検証する最小エンドポイント。
 * 認証系は src/api/routes/api/auth/**、Vault 系は src/api/routes/api/vaults/**・
 * src/api/routes/api/tree/** にある。
 */

import { createRoute } from 'honox/factory';

export const GET = createRoute((c) => {
  return c.json({ status: 'ok', service: 'tektite' });
});
