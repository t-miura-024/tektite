import { createRoute } from 'honox/factory';

import { toRouteContext, type RouteContext } from '@/api/_lib/route-context';
import {
  isProxyConfigError,
  authenticateRequest,
  resolveProxyConfig,
} from '@/api/_lib/github-proxy';
import { fetchRawFromGithub, tryServeRawFromR2 } from '@/api/_lib/raw-helpers';
/** 添付raw配信。プロキシで返し二重デコードを防ぐ。 */

import { isValidGitHubName } from '@/domain/vault';

/** パスパラメータを文字列に正規化する（配列で渡された場合は先頭を採用） */
function paramToString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function handleRawGet(context: RouteContext): Promise<Response> {
  const { env, request, params } = context;
  const owner = paramToString(params.owner);
  const repoName = paramToString(params.repo);
  if (!isValidGitHubName(owner) || !isValidGitHubName(repoName)) {
    return Response.json({ error: 'invalid_vault_ref' }, { status: 400 });
  }
  const _rawPathParam = paramToString(params.path);
  let _decoded: string;
  try {
    _decoded = decodeURIComponent(_rawPathParam);
  } catch {
    _decoded = _rawPathParam;
  }
  const _normalized = _decoded
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/');
  const rawPath = _normalized.length === 0 ? null : _normalized;
  if (rawPath === null) {
    return Response.json({ error: 'invalid_raw_path' }, { status: 400 });
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
  const cachedResponse = await tryServeRawFromR2(bucket, owner, repoName, rawPath);
  if (cachedResponse !== null) {
    return cachedResponse;
  }
  return fetchRawFromGithub(
    bucket,
    owner,
    repoName,
    rawPath,
    config.apiBaseUrl,
    auth.token,
    (p: string) =>
      p
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/'),
  );
}

export const GET = createRoute((c) =>
  handleRawGet(toRouteContext(c.env, c.req.raw, c.req.param())),
);
