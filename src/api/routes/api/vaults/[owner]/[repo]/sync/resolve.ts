/**
 * 同期衝突の解決。overwriteはGitHub側、adoptはローカル側の内容を採用する。
 * 明示同期で保留された同一ノートの重なりを対象とし、初期同期前のVaultは409で防衛する。
 * overwriteはR2をGitHubの現在内容で更新し、adoptはR2内容をGitHubへ1コミットで反映する。
 * 結果はowner・name・path・resolutionとshaで返す。
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

  let _parsedPath: string;
  let _parsedResolution: 'overwrite' | 'adopt';
  {
    let _body: unknown;
    try {
      _body = await request.json();
    } catch {
      return Response.json({ error: 'invalid_body' }, { status: 400 });
    }
    if (
      typeof _body !== 'object' ||
      _body === null ||
      !('path' in _body) ||
      !('resolution' in _body)
    ) {
      return Response.json({ error: 'invalid_body' }, { status: 400 });
    }
    const _path = _body.path;
    if (typeof _path !== 'string' || _path.length === 0) {
      return Response.json({ error: 'invalid_body' }, { status: 400 });
    }
    const _resolution = _body.resolution;
    if (_resolution !== 'overwrite' && _resolution !== 'adopt') {
      return Response.json({ error: 'invalid_body' }, { status: 400 });
    }
    _parsedPath = _path;
    _parsedResolution = _resolution;
  }
  const path = _parsedPath;
  const resolution = _parsedResolution;

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
