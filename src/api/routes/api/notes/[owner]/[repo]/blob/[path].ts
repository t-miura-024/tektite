/**
 * ノート取得・保存。GETは本文とshaを返し、PUTは本文を保存する。
 * 同期済みVaultはR2を優先し、読込時shaとの不一致は409のconflictで返す。
 * 未同期VaultはGitHubのContents APIへ直行する。pushは同期時に束ねる。
 * ノートパスはパーセントエンコードされた1セグメントとして受け取り復元する。
 */

import { createRoute } from 'honox/factory';

import { toRouteContext, type RouteContext } from '@/api/_lib/route-context';
import {
  authenticateRequest,
  isProxyConfigError,
  resolveProxyConfig,
} from '@/api/_lib/github-proxy';
import { isValidGitHubName } from '@/domain/vault';
import { paramToString, parseSaveNoteBody, resolveNotePath } from '@/api/_lib/note-blob-helpers';
import {
  fetchNoteFromGithub,
  handleR2Put,
  putNoteToGithub,
  tryServeFromR2,
} from '@/api/_lib/note-blob-operations';

export async function handleNoteBlobGet(context: RouteContext): Promise<Response> {
  const { env, request, params } = context;
  const owner = paramToString(params.owner);
  const repoName = paramToString(params.repo);
  if (!isValidGitHubName(owner) || !isValidGitHubName(repoName)) {
    return Response.json({ error: 'invalid_vault_ref' }, { status: 400 });
  }
  const notePath = resolveNotePath(params.path);
  if (notePath === null) {
    return Response.json({ error: 'invalid_note_path' }, { status: 400 });
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
  if (bucket) {
    const cachedResponse = await tryServeFromR2(bucket, owner, repoName, notePath);
    if (cachedResponse !== null) {
      return cachedResponse;
    }
  }
  return fetchNoteFromGithub(bucket, owner, repoName, notePath, config.apiBaseUrl, auth.token);
}

export async function handleNoteBlobPut(context: RouteContext): Promise<Response> {
  const { env, request, params } = context;
  const owner = paramToString(params.owner);
  const repoName = paramToString(params.repo);
  if (!isValidGitHubName(owner) || !isValidGitHubName(repoName)) {
    return Response.json({ error: 'invalid_vault_ref' }, { status: 400 });
  }
  const notePath = resolveNotePath(params.path);
  if (notePath === null) {
    return Response.json({ error: 'invalid_note_path' }, { status: 400 });
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
  const body = parseSaveNoteBody(await request.json().catch(() => null));
  if (body === null) {
    return Response.json({ error: 'invalid_note_body' }, { status: 400 });
  }
  const bucket = env.VAULT_BUCKET;
  if (bucket) {
    const r2Response = await handleR2Put(bucket, owner, repoName, notePath, body);
    if (r2Response !== null) {
      return r2Response;
    }
  }
  return putNoteToGithub(bucket, owner, repoName, notePath, body, config.apiBaseUrl, auth.token);
}

export const GET = createRoute((c) =>
  handleNoteBlobGet(toRouteContext(c.env, c.req.raw, c.req.param())),
);

export const PUT = createRoute((c) =>
  handleNoteBlobPut(toRouteContext(c.env, c.req.raw, c.req.param())),
);
