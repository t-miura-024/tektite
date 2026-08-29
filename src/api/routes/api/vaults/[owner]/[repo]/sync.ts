/**
 * Vault 同期: POST|GET /api/vaults/:owner/:repo/sync, POST .../sync/resolve
 *
 * - POST .../sync（初期同期 / 明示同期。完了条件 2 / 5）:
 *   - R2 に同期済みメタが無い Vault は GitHub から全量を取り込む（初期同期）。
 *     認可確認済み（write 権限）のリポジトリのみ実行される
 *   - メタがある Vault は差分同期（M5）を実行する。ツリー sha 比較でプル
 *     （変更 blob のみ取得）し、未反映の変更を 1 コミットに束ねてプッシュする。
 *     同期衝突（GitHub 側変更 + R2 側ローカル保存）は保留して conflicts として
 *     返し、UI（Conflict UI 拡張）が上書き/取り込みで解決する
 * - GET .../sync: 同期状態（最終同期時刻・失敗マーク）を返す（完了条件 10）
 * - POST .../sync/resolve: 同期衝突の解決（overwrite: GitHub 側採用 /
 *   adopt: ローカル側採用。完了条件 6）
 *
 * 取り込み内容（初期同期）:
 * 1. デフォルトブランチの解決（リポジトリ情報）
 * 2. ツリー全体（Git Trees API recursive=1）から Markdown blob の path + sha を抽出
 * 3. Markdown blob を同時 8 件ずつ取得し、R2 の `notes/{path}` へ書き込む
 * 4. ツリーを R2 の `tree` へ、完了マーカーを `meta` へ書き込む
 *
 * 応答:
 * - パラメータ不正                  → 400 { error: 'invalid_vault_ref' }
 * - 未ログイン                      → 401 { error: 'unauthenticated' }
 * - write 権限なし（初期同期）      → 403 { error: 'read_only_vault' }
 * - Vault（リポジトリ）が見つからない → 404 { error: 'not_found' }
 * - レートリミット（403 / 429）     → 429 { error: 'rate_limited' }
 * - R2 バインディングなし           → 503 { error: 'storage_unavailable' }
 * - 正常（初回）                    → 200 { status: 'initialized', notes }
 * - 正常（差分同期）                → 200 { status: 'synced', pulled, pushed, conflicts }
 * - 同期状態（GET）                 → 200 { syncedAt, lastSyncError, lastFailedAt }
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
import { syncVault } from '@/api/_lib/vault-sync';
import { performInitialSync } from '@/api/_lib/vault-initial-sync';

/** パスパラメータを文字列に正規化する（配列で渡された場合は先頭を採用） */
function paramToString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function handleVaultSyncPost(context: RouteContext): Promise<Response> {
  const { env, request, params } = context;
  const owner = paramToString(params.owner);
  const repoName = paramToString(params.repo);
  if (!isValidGitHubName(owner) || !isValidGitHubName(repoName)) {
    return Response.json({ error: 'invalid_vault_ref' }, { status: 400 });
  }
  const bucket = env.VAULT_BUCKET;
  if (!bucket) {
    return Response.json(
      { error: 'storage_unavailable', message: 'Vault ストレージ（R2）が設定されていません。' },
      { status: 503 },
    );
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
  const existingMeta = await readVaultMeta(bucket, owner, repoName);
  if (existingMeta !== null) {
    let _isExplicitSync: boolean | undefined = undefined;
    let rawBody = '';
    let _failed = false;
    try {
      rawBody = await request.text();
    } catch {
      _failed = true;
    }
    if (_failed) {
      _isExplicitSync = false;
    }
    if (_isExplicitSync === undefined && rawBody.length === 0) {
      _isExplicitSync = false;
    }
    if (_isExplicitSync === undefined) {
      let action: unknown = null;
      let _parseFailed = false;
      let parsedBody: unknown = null;
      try {
        parsedBody = JSON.parse(rawBody);
        if (typeof parsedBody === 'object' && parsedBody !== null && 'action' in parsedBody) {
          action = parsedBody.action;
        }
      } catch {
        _parseFailed = true;
      }
      if (_parseFailed) {
        _isExplicitSync = false;
      }
      if (!_parseFailed) {
        _isExplicitSync = action === 'sync';
      }
    }
    if (_isExplicitSync === undefined) {
      _isExplicitSync = false;
    }
    const isExplicitSync = _isExplicitSync;
    if (!isExplicitSync) {
      return Response.json(
        {
          owner,
          name: repoName,
          status: 'already_synced',
          defaultBranch: existingMeta.defaultBranch,
          notes: 0,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const outcome = await syncVault(
      config.apiBaseUrl,
      auth.token,
      bucket,
      owner,
      repoName,
      'explicit',
    );
    if (!outcome.ok) {
      if (outcome.reason === 'sync_conflict') {
        return Response.json({ error: 'sync_conflict' }, { status: 409 });
      }
      return outcome.response;
    }
    return Response.json(
      {
        owner,
        name: repoName,
        status: outcome.result.status,
        defaultBranch: existingMeta.defaultBranch,
        syncedAt: outcome.result.syncedAt,
        pulled: outcome.result.pulled,
        pushed: outcome.result.pushed,
        conflicts: outcome.result.conflicts,
        remaining: outcome.result.remaining,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return performInitialSync({
    bucket,
    owner,
    repoName,
    apiBaseUrl: config.apiBaseUrl,
    token: auth.token,
  });
}

export const POST = createRoute((c) =>
  handleVaultSyncPost(toRouteContext(c.env, c.req.raw, c.req.param())),
);

/**
 * 同期状態: GET /api/vaults/:owner/:repo/sync
 *
 * R2 の meta から最終同期時刻と失敗マークを返す（定時同期の失敗が UI に
 * 表示される。完了条件 10）。GitHub API は消費しない。
 */
export async function handleVaultSyncGet(context: RouteContext): Promise<Response> {
  const { env } = context;
  const _owner = paramToString(context.params.owner);
  const _repoName = paramToString(context.params.repo);
  if (!isValidGitHubName(_owner) || !isValidGitHubName(_repoName)) {
    return Response.json({ error: 'invalid_vault_ref' }, { status: 400 });
  }
  const params = { owner: _owner, repoName: _repoName };
  const bucket = env.VAULT_BUCKET;
  if (!bucket) {
    return Response.json(
      { error: 'storage_unavailable', message: 'Vault ストレージ（R2）が設定されていません。' },
      { status: 503 },
    );
  }
  const meta = await readVaultMeta(bucket, params.owner, params.repoName);
  if (meta === null) {
    return Response.json(
      {
        owner: params.owner,
        name: params.repoName,
        syncedAt: null,
        lastSyncError: null,
        lastFailedAt: null,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return Response.json(
    {
      owner: params.owner,
      name: params.repoName,
      syncedAt: meta.syncedAt,
      lastSyncError: meta.lastSyncError,
      lastFailedAt: meta.lastFailedAt,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export const GET = createRoute((c) =>
  handleVaultSyncGet(toRouteContext(c.env, c.req.raw, c.req.param())),
);
