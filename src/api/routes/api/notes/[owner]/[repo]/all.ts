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

/** ノート一括取得。全件返し索引初期化に使う。失敗は除外する。 */

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
