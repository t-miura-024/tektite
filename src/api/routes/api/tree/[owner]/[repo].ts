import { createRoute } from 'honox/factory';

import { toRouteContext, type RouteContext } from '@/api/_lib/route-context';
import {
  isProxyConfigError,
  authenticateRequest,
  resolveProxyConfig,
} from '@/api/_lib/github-proxy';
import { isValidGitHubName } from '@/domain/vault';
import {
  cacheTreeIfNeeded,
  fetchDefaultBranch,
  fetchTree,
  tryServeTreeFromR2,
} from '@/api/_lib/tree-helpers';

/**
 * ファイルツリー: GET /api/tree/:owner/:repo
 *
 * 対象 Vault のデフォルトブランチのファイルツリーを返す（MVP はデフォルト
 * ブランチのみ対象）。まずリポジトリ情報でデフォルトブランチを解決し、
 * Git Trees API（recursive=1）で 1 回にまとめて取得する。
 *
 * 応答:
 * - パラメータ不正                 → 400 { error: 'invalid_vault_ref' }
 * - 未ログイン                     → 401 { error: 'unauthenticated' }
 * - Vault（リポジトリ）が見つからない → 404 { error: 'not_found' }
 * - レートリミット（403 / 429）    → 429 { error: 'rate_limited' }
 * - 正常                           → 200 { owner, name, defaultBranch, truncated, entries }
 *
 * entries は [{ path, type: 'file' | 'directory' }] のフラット列。
 * 隠れディレクトリの除外・ツリー構築はクライアントのドメイン層（src/domain/tree）
 * が担当する。サブモジュール（type: 'commit'）は対象外のため含めない。
 */

/** パスパラメータを文字列に正規化する（配列で渡された場合は先頭を採用） */
function paramToString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function handleTreeGet(context: RouteContext): Promise<Response> {
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
  const cachedResponse = await tryServeTreeFromR2(bucket, owner, repoName);
  if (cachedResponse !== null) {
    return cachedResponse;
  }
  const branchResult = await fetchDefaultBranch(config.apiBaseUrl, auth.token, owner, repoName);
  if (!branchResult.ok) {
    return branchResult.response;
  }
  const treeResult = await fetchTree(
    config.apiBaseUrl,
    auth.token,
    owner,
    repoName,
    branchResult.branch,
  );
  if (!treeResult.ok) {
    return treeResult.response;
  }
  await cacheTreeIfNeeded(
    bucket,
    owner,
    repoName,
    treeResult.defaultBranch,
    treeResult.truncated,
    treeResult.entries,
    treeResult.body,
  );
  return Response.json(
    {
      owner,
      name: repoName,
      defaultBranch: treeResult.defaultBranch,
      truncated: treeResult.truncated,
      entries: treeResult.entries.map(({ path, type }) => ({ path, type })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export const GET = createRoute((c) =>
  handleTreeGet(toRouteContext(c.env, c.req.raw, c.req.param())),
);
