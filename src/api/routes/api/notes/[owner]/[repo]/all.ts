import { createRoute } from 'honox/factory';

import { toRouteContext, type RouteContext } from '@/api/_lib/route-context';
import {
  isProxyConfigError,
  authenticateRequest,
  resolveProxyConfig,
} from '@/api/_lib/github-proxy';
import { isValidGitHubName } from '@/domain/vault';
import {
  extractNoteBlobs,
  fetchDefaultBranch,
  fetchNotesChunked,
  fetchTreeEntries,
  tryServeFromR2,
} from '@/api/_lib/notes-all-helpers';

/**
 * ノート一括取得: GET /api/notes/:owner/:repo/all
 *
 * 対象 Vault の全 Markdown ノート（本文 + sha）を 1 リクエストで返す。
 * クライアント側ノート索引（M4）の初期展開に使う。MVP はデフォルトブランチのみ
 * 対象（/api/tree と同じ前提）。
 *
 * 流れ: リポジトリ情報でデフォルトブランチを解決 → Git Trees API（recursive=1）
 * で全 blob の path と sha を取得 → Markdown blob だけを Git Blobs API で並列取得
 * （同時 8 件ずつのチャンク。個人 Vault 規模のノート数でもレートリミットに収まる）→
 * [{ path, sha, content }] に整形する。
 *
 * 個別 blob の取得失敗（404 等）は応答から除外する（索引が不完全になるだけで
 * 画面は継続する。個別取得と同じ寛容な扱い）。ツリーの truncated はフラグで
 * 通知し、クライアントが索引の網羅性を判断できるようにする。
 *
 * 応答:
 * - パラメータ不正                  → 400 { error: 'invalid_vault_ref' }
 * - 未ログイン                      → 401 { error: 'unauthenticated' }
 * - Vault（リポジトリ）が見つからない → 404 { error: 'not_found' }
 * - レートリミット（403 / 429）     → 429 { error: 'rate_limited' }
 * - 正常                            → 200 { owner, name, defaultBranch, truncated, notes }
 */

/** パスパラメータを文字列に正規化する（配列で渡された場合は先頭を採用） */
function paramToString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function handleNotesAllGet(context: RouteContext): Promise<Response> {
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
  const cachedResponse = await tryServeFromR2(bucket, owner, repoName);
  if (cachedResponse !== null) {
    return cachedResponse;
  }
  const branchResult = await fetchDefaultBranch(config.apiBaseUrl, auth.token, owner, repoName);
  if (!branchResult.ok) {
    return branchResult.response;
  }
  const defaultBranch = branchResult.branch;
  const treeResult = await fetchTreeEntries(
    config.apiBaseUrl,
    auth.token,
    owner,
    repoName,
    defaultBranch,
  );
  if (!treeResult.ok) {
    return treeResult.response;
  }
  const noteBlobs = extractNoteBlobs(treeResult.entries);
  const fetched = await fetchNotesChunked(
    config.apiBaseUrl,
    auth.token,
    owner,
    repoName,
    noteBlobs,
    bucket,
    treeResult.body,
  );
  return Response.json(
    {
      owner,
      name: repoName,
      defaultBranch,
      truncated: fetched.truncated,
      notes: fetched.notes,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export const GET = createRoute((c) =>
  handleNotesAllGet(toRouteContext(c.env, c.req.raw, c.req.param())),
);
