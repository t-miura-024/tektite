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

import type { RouteContext } from '@/api/_lib/route-context';
import { isValidGitHubName } from '@/domain/vault';
import {
  ProxyConfigError,
  authenticateRequest,
  githubApiFetch,
  githubUnreachable,
  mapGithubFailure,
  resolveProxyConfig,
} from '@/api/_lib/github-proxy';
import {
  readVaultMeta,
  writeCachedNote,
  writeVaultMeta,
  writeVaultTree,
} from '@/api/_lib/r2-vault';
import { syncVault } from '@/api/_lib/vault-sync';
interface GithubRepoInfo {
  default_branch?: unknown;
  permissions?: { push?: unknown };
}

interface GithubTreeEntry {
  path?: unknown;
  type?: unknown;
  sha?: unknown;
}

interface GithubTreeResponse {
  sha?: unknown;
  truncated?: unknown;
  tree?: GithubTreeEntry[];
}

/** パスパラメータを文字列に正規化する（配列で渡された場合は先頭を採用） */
function paramToString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/** GitHub Blobs API の base64 本文を UTF-8 文字列に復号する */
function decodeBase64Content(encoded: string): string {
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Blob 1 件を取得して本文を返す（ネットワーク断・404・形式不正は null）。
 * 失敗を null に握りつぶすことで、1 ノートの失敗が同期全体を落とさない。
 */
async function fetchBlobContent(
  baseUrl: string,
  token: string,
  owner: string,
  repoName: string,
  sha: string,
): Promise<string | null> {
  let response: Response;
  try {
    response = await githubApiFetch(
      baseUrl,
      `/repos/${owner}/${repoName}/git/blobs/${encodeURIComponent(sha)}`,
      token,
    );
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  const body = (await response.json().catch(() => null)) as {
    content?: unknown;
    encoding?: unknown;
  } | null;
  if (!body || body.encoding !== 'base64' || typeof body.content !== 'string') {
    return null;
  }
  return decodeBase64Content(body.content);
}

/** Markdown blob 並列取得の同時実行上限（GitHub のレートリミット消費を抑える） */
const BLOB_FETCH_CONCURRENCY = 8;

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
    if (error instanceof ProxyConfigError) {
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

  // 既に初期同期済みの Vault:
  // - body に action: 'sync' がある（明示同期。M5）: ツリー sha 比較でプルし、
  //   未反映の変更を 1 コミットに束ねてプッシュする（GitHub API の消費はツリー
  //   1 回 + 変更 blob のみ）
  // - action なし（Vault オープン時の初期同期チェック）: GitHub に一切触れず
  //   already_synced を返す（Vault を開くだけでは GitHub API を消費しない）
  const existingMeta = await readVaultMeta(bucket, owner, repoName);
  if (existingMeta !== null) {
    let rawBody = '';
    try {
      rawBody = await request.text();
    } catch {
      rawBody = '';
    }
    let isExplicitSync = false;
    if (rawBody.length > 0) {
      let parsed: { action?: unknown } | null = null;
      try {
        parsed = JSON.parse(rawBody) as { action?: unknown };
      } catch {
        parsed = null;
      }
      isExplicitSync = parsed?.action === 'sync';
    }
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
        // 明示同期は conflicts を返して UI に解決させるため、ここには来ない
        // （防衛線）
        return Response.json({ error: 'sync_conflict' }, { status: 409 });
      }
      return outcome.response;
    }
    return Response.json(
      {
        owner,
        name: repoName,
        status: 'synced',
        defaultBranch: existingMeta.defaultBranch,
        syncedAt: outcome.result.syncedAt,
        pulled: outcome.result.pulled,
        pushed: outcome.result.pushed,
        conflicts: outcome.result.conflicts,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // 1) リポジトリ情報からデフォルトブランチと write 権限を確認する
  let repoResponse: Response;
  try {
    repoResponse = await githubApiFetch(
      config.apiBaseUrl,
      `/repos/${owner}/${repoName}`,
      auth.token,
    );
  } catch {
    return githubUnreachable();
  }
  const repoFailure = mapGithubFailure(repoResponse);
  if (repoFailure) {
    return repoFailure;
  }
  const repoInfo = (await repoResponse.json().catch(() => null)) as GithubRepoInfo | null;
  if (
    !repoInfo ||
    typeof repoInfo.default_branch !== 'string' ||
    repoInfo.default_branch.length === 0
  ) {
    return Response.json({ error: 'github_error' }, { status: 502 });
  }
  if (repoInfo.permissions?.push !== true) {
    return Response.json(
      { error: 'read_only_vault', message: 'この Vault には書き込み権限がありません。' },
      { status: 403 },
    );
  }
  const defaultBranch = repoInfo.default_branch;

  // 2) ツリー全体を取得する（コミット 0 件の空リポジトリは 404 → 空ツリー）
  let treeResponse: Response;
  try {
    treeResponse = await githubApiFetch(
      config.apiBaseUrl,
      `/repos/${owner}/${repoName}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
      auth.token,
    );
  } catch {
    return githubUnreachable();
  }
  const treeFailure = mapGithubFailure(treeResponse);
  let treeBody: GithubTreeResponse;
  if (treeResponse.status === 404) {
    treeBody = { sha: null, truncated: false, tree: [] };
  } else {
    if (treeFailure) {
      return treeFailure;
    }
    const parsed = (await treeResponse.json().catch(() => null)) as GithubTreeResponse | null;
    if (!parsed || !Array.isArray(parsed.tree)) {
      return Response.json({ error: 'github_error' }, { status: 502 });
    }
    treeBody = parsed;
  }

  // 3) Markdown blob の path + sha を抽出する（検索対象は Note のみ）
  const treeEntries = treeBody.tree ?? [];
  const noteBlobs: { path: string; sha: string }[] = [];
  const entries: { path: string; type: 'file' | 'directory'; sha: string | null }[] = [];
  for (const entry of treeEntries) {
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      continue;
    }
    if (entry.type === 'blob') {
      entries.push({
        path: entry.path,
        type: 'file',
        sha: typeof entry.sha === 'string' && entry.sha.length > 0 ? entry.sha : null,
      });
      if (entry.path.endsWith('.md') && typeof entry.sha === 'string' && entry.sha.length > 0) {
        noteBlobs.push({ path: entry.path, sha: entry.sha });
      }
    } else if (entry.type === 'tree') {
      entries.push({ path: entry.path, type: 'directory', sha: null });
    }
  }

  // 4) Markdown blob を同時 8 件ずつ取得して R2 へ書き込む（失敗ノートは欠落させる）
  let notes = 0;
  for (let offset = 0; offset < noteBlobs.length; offset += BLOB_FETCH_CONCURRENCY) {
    const chunk = noteBlobs.slice(offset, offset + BLOB_FETCH_CONCURRENCY);
    // oxlint-disable-next-line no-await-in-loop -- 同時実行数を 8 に制限する意図的なチャンク処理
    const chunkResults = await Promise.all(
      chunk.map(async ({ path, sha }) => {
        const content = await fetchBlobContent(config.apiBaseUrl, auth.token, owner, repoName, sha);
        return content === null ? null : { path, sha, content };
      }),
    );
    for (const result of chunkResults) {
      if (result === null) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- 取得済みノートの R2 書き込み（チャンク内で順次実行）のため
      await writeCachedNote(bucket, owner, repoName, result.path, {
        sha: result.sha,
        content: result.content,
      });
      notes += 1;
    }
  }

  // 5) ツリー + 同期完了マーカーを書き込む（M5 は meta.treeSha で差分を検出する）
  const treeSha = typeof treeBody.sha === 'string' && treeBody.sha.length > 0 ? treeBody.sha : null;
  await writeVaultTree(bucket, owner, repoName, {
    defaultBranch,
    truncated: treeBody.truncated === true,
    treeSha,
    entries,
  });
  await writeVaultMeta(bucket, owner, repoName, {
    syncedAt: new Date().toISOString(),
    defaultBranch,
    treeSha,
  });

  return Response.json(
    { owner, name: repoName, status: 'initialized', defaultBranch, notes },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export const POST = createRoute((c) =>
  handleVaultSyncPost({ env: c.env as Env, request: c.req.raw, params: c.req.param() }),
);

/** パスパラメータのヘルパー（handleVaultSyncGet / resolve で使う） */
function requireVaultParams(context: RouteContext): { owner: string; repoName: string } | null {
  const owner = paramToString(context.params.owner);
  const repoName = paramToString(context.params.repo);
  if (!isValidGitHubName(owner) || !isValidGitHubName(repoName)) {
    return null;
  }
  return { owner, repoName };
}

/**
 * 同期状態: GET /api/vaults/:owner/:repo/sync
 *
 * R2 の meta から最終同期時刻と失敗マークを返す（定時同期の失敗が UI に
 * 表示される。完了条件 10）。GitHub API は消費しない。
 */
export async function handleVaultSyncGet(context: RouteContext): Promise<Response> {
  const { env } = context;
  const params = requireVaultParams(context);
  if (params === null) {
    return Response.json({ error: 'invalid_vault_ref' }, { status: 400 });
  }
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
  handleVaultSyncGet({ env: c.env as Env, request: c.req.raw, params: c.req.param() }),
);
