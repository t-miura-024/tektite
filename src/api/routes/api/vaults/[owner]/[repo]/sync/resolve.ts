/**
 * 同期衝突の解決: POST /api/vaults/:owner/:repo/sync/resolve
 *
 * 明示同期で保留された同期衝突（プル時に GitHub 側の変更と R2 側のローカル
 * 保存が同一 Note で重なった状態）を解決する（完了条件 6。既存 Conflict UI の
 * 上書き/取り込みに対応する）。
 *
 * body: `{ path: "<ノートパス>", resolution: "overwrite" | "adopt" }`
 * - overwrite: GitHub 側の内容を採用する。R2 のノートを GitHub の現在内容で
 *   更新し、GitHub 側で削除されたノートは R2 から削除する
 * - adopt: ローカル側の内容を採用する。R2 のローカル内容を GitHub へ
 *   1 コミットで反映する（次の同期で同一判定になり、衝突が解消する）
 *
 * 応答:
 * - パラメータ不正 / ボディ不正  → 400 { error: 'invalid_vault_ref' | 'invalid_body' }
 * - 未ログイン                  → 401 { error: 'unauthenticated' }
 * - ノートが見つからない        → 404 { error: 'not_found' }
 * - レートリミット（403 / 429） → 429 { error: 'rate_limited' }
 * - R2 バインディングなし       → 503 { error: 'storage_unavailable' }
 * - 正常                        → 200 { owner, name, path, resolution }
 */

import { createRoute } from 'honox/factory';

import { toRouteContext, type RouteContext } from '@/api/_lib/route-context';
import {
  authenticateRequest,
  isProxyConfigError,
  resolveProxyConfig,
} from '@/api/_lib/github-proxy';
import { isValidGitHubName } from '@/domain/vault';
import { readVaultMeta } from '@/api/_lib/r2-vault';
import { resolveSyncConflict } from '@/api/_lib/vault-sync-resolve';

/** パスパラメータを文字列に正規化する（配列で渡された場合は先頭を採用） */
function paramToString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/** ボディから path と resolution を読む（形式不正は null） */
async function readRequestBody(
  request: Request,
): Promise<{ path: string; resolution: 'overwrite' | 'adopt' } | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || !('path' in body) || !('resolution' in body)) {
    return null;
  }
  const { path, resolution } = body;
  if (typeof path !== 'string' || path.length === 0) {
    return null;
  }
  if (resolution !== 'overwrite' && resolution !== 'adopt') {
    return null;
  }
  return { path, resolution };
}

export async function handleVaultSyncResolvePost(context: RouteContext): Promise<Response> {
  const { env, request, params } = context;
  const owner = paramToString(params.owner);
  const repoName = paramToString(params.repo);
  if (!isValidGitHubName(owner) || !isValidGitHubName(repoName)) {
    return Response.json({ error: 'invalid_vault_ref' }, { status: 400 });
  }

  let config;
  try {
    config = resolveProxyConfig(env);
  } catch (error) {
    if (isProxyConfigError(error)) {
      return Response.json(
        { error: 'auth_not_configured', message: error.message },
        { status: 503 },
      );
    }
    throw error;
  }

  const auth = await authenticateRequest(request, config);
  if (!auth.ok) {
    return auth.response;
  }

  const bucket = env.VAULT_BUCKET;
  if (!bucket) {
    return Response.json(
      { error: 'storage_unavailable', message: 'Vault ストレージ（R2）が設定されていません。' },
      { status: 503 },
    );
  }

  // 初期同期前の Vault（メタなし）の衝突解決は意味がないため防衛
  const meta = await readVaultMeta(bucket, owner, repoName);
  if (meta === null) {
    return Response.json({ error: 'not_synced' }, { status: 409 });
  }

  const parsed = await readRequestBody(request);
  if (parsed === null) {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }
  const { path, resolution } = parsed;

  const outcome = await resolveSyncConflict(
    config.apiBaseUrl,
    auth.token,
    bucket,
    owner,
    repoName,
    path,
    resolution,
  );
  if (!outcome.ok) {
    return outcome.response;
  }
  return Response.json(
    { owner, name: repoName, path, resolution, sha: outcome.sha },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export const POST = createRoute((c) =>
  handleVaultSyncResolvePost(toRouteContext(c.env, c.req.raw, c.req.param())),
);
