/**
 * ノート取得/保存: GET|PUT /api/notes/:owner/:repo/blob/:path
 *
 * GET: 対象 Vault のファイル本文と sha を返す。対象はデフォルトブランチのみ
 * （Contents API は ref 省略時にデフォルトブランチを返す）。
 * sha は保存時の楽観ロック（M3）で必須のため必ず応答に含める。
 *
 * PUT: 対象ファイルを保存する。コミットメッセージは自動生成（application 層）
 * された message をそのまま渡す。body は
 * `{ content: "<base64>", sha?: "<読込時 sha>", message: "<コミットメッセージ>" }`。
 *
 * M4 の R2 先行化（完了条件 3 / 8）:
 * - 初期同期済み（R2 メタあり）の Vault は R2 へだけ反映し、GitHub API を
 *   消費しない。GitHub への push は同期時（M5）のみ
 * - 競合検出は GitHub の sha ではなく、R2 上のコンテンツハッシュ（SHA-256）
 *   で行う。読込時 sha が R2 の現在値と一致しない場合は既存の Conflict フロー
 *   と同じ `{ error: 'conflict' }` の 409 を返す（UI の差分表示は維持される）
 * - 未同期（R2 メタなし）の Vault は従来どおり GitHub の Contents API へ
 *   保存する（sha 楽観ロックは GitHub 側の 409 で検出する）
 *
 * Cloudflare Pages Functions はキャッチオール（[...path]）をサポートしない
 * ため、ノートパス全体（/ 区切り）を 1 セグメントにパーセントエンコードして
 * 受け取る（例: daily/2026-08-08.md → daily%2F2026-08-08.md）。
 * パラメータは実行環境によりデコード済みの場合があるため、decodeSegment が
 * 二重デコードを防ぎながら元のパスを復元する。
 *
 * 応答:
 * - パラメータ不正                 → 400 { error: 'invalid_vault_ref' | 'invalid_note_path' }
 * - ボディ不正（PUT）              → 400 { error: 'invalid_note_body' }
 * - 未ログイン                     → 401 { error: 'unauthenticated' }
 * - ノート（ファイル）が見つからない → 404 { error: 'not_found' }
 * - レートリミット（403 / 429）    → 429 { error: 'rate_limited' }
 * - sha 楽観ロック競合（PUT）      → 409 { error: 'conflict', message }
 * - 正常 GET                       → 200 { owner, name, path, sha, content }
 * - 正常 PUT                       → 200 { owner, name, path, sha }
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
