/**
 * ノート取得/保存: GET|PUT /api/notes/:owner/:repo/blob/:path
 *
 * GET: 対象 Vault のファイル本文と sha を返す。対象はデフォルトブランチのみ
 * （Contents API は ref 省略時にデフォルトブランチを返す）。
 * sha は保存時の楽観ロック（M3）で必須のため必ず応答に含める。
 *
 * PUT: 対象ファイルを保存する。Contents API の更新（sha 指定あり）と新規作成
 * （sha なし）を同一エンドポイントでプロキシし、コミットメッセージは自動生成
 * （application 層）された message をそのまま渡す。body は
 * `{ content: "<base64>", sha?: "<読込時 sha>", message: "<コミットメッセージ>" }`。
 * sha がリモートと一致しない場合、GitHub は 409 を返すため、楽観ロック競合
 * （Conflict）として `{ error: 'conflict' }` の 409 をそのままクライアントに伝える。
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

import { isValidGitHubName } from '@/domain/vault';
import {
  ProxyConfigError,
  authenticateRequest,
  githubApiFetch,
  githubUnreachable,
  mapGithubFailure,
  resolveProxyConfig,
} from '@functions/api/_lib/github-proxy';

interface GithubContentsResponse {
  type?: unknown;
  encoding?: unknown;
  content?: unknown;
  sha?: unknown;
}

/** パスパラメータを文字列に正規化する（配列で渡された場合は先頭を採用） */
function paramToString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * パスセグメントの URL デコード。
 * Pages Functions のパスパラメータはデコード前の生セグメントで届く想定だが、
 * 実行環境によっては既にデコード済みの可能性があるため、不正なパーセント
 * エスケープでエラーになる場合だけ元の文字列を採用する（二重デコード回避）。
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** パスパラメータ（パス全体を 1 セグメントにエンコードしたもの）をノートパスに復元する */
function resolveNotePath(value: string | string[] | undefined): string | null {
  const rawPath = paramToString(value);
  const notePath = decodeSegment(rawPath)
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/');
  if (notePath.length === 0) {
    return null;
  }
  return notePath;
}

/** GitHub Contents API の base64 本文を UTF-8 文字列に復号する */
function decodeBase64Content(encoded: string): string {
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 標準 base64（btoa 出力相当）かどうか */
function isValidBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

/** PUT ボディ（sha は新規作成時は省略される） */
interface SaveNoteBody {
  content?: unknown;
  sha?: unknown;
  message?: unknown;
}

/** PUT ボディを検証し、GitHub へ転送する形に正規化する（不正は null） */
function parseSaveNoteBody(raw: unknown): {
  content: string;
  message: string;
  sha: string | null;
} | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const body = raw as SaveNoteBody;
  if (typeof body.content !== 'string' || !isValidBase64(body.content)) {
    return null;
  }
  if (typeof body.message !== 'string' || body.message.length === 0) {
    return null;
  }
  if (body.sha !== undefined && (typeof body.sha !== 'string' || body.sha.length === 0)) {
    return null;
  }
  return {
    content: body.content,
    message: body.message,
    sha: typeof body.sha === 'string' ? body.sha : null,
  };
}

/** ノートパスを Contents API の URL パス（セグメント単位でエンコード）に変換する */
function encodeNotePath(notePath: string): string {
  return notePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
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

  // Contents API は ref 省略時にデフォルトブランチの内容を返す
  let response: Response;
  try {
    response = await githubApiFetch(
      config.apiBaseUrl,
      `/repos/${owner}/${repoName}/contents/${encodeNotePath(notePath)}`,
      auth.token,
    );
  } catch {
    return githubUnreachable();
  }
  const failure = mapGithubFailure(response);
  if (failure) {
    return failure;
  }
  const body = (await response.json().catch(() => null)) as GithubContentsResponse | null;
  if (
    !body ||
    body.type !== 'file' ||
    body.encoding !== 'base64' ||
    typeof body.content !== 'string' ||
    body.content.length === 0 ||
    typeof body.sha !== 'string' ||
    body.sha.length === 0
  ) {
    // ディレクトリ指定・巨大ファイル（content なし）・形式不正はノートとして扱えない
    return Response.json({ error: 'github_error' }, { status: 502 });
  }

  return Response.json(
    {
      owner,
      name: repoName,
      path: notePath,
      sha: body.sha,
      content: decodeBase64Content(body.content),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};

export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
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

  const body = parseSaveNoteBody(await request.json().catch(() => null));
  if (body === null) {
    return Response.json({ error: 'invalid_note_body' }, { status: 400 });
  }

  // 転送ボディ: 新規作成（sha なし）と更新（sha あり）を Contents API の規約に合わせる
  const githubBody: { content: string; message: string; sha?: string } = {
    content: body.content,
    message: body.message,
  };
  if (body.sha !== null) {
    githubBody.sha = body.sha;
  }

  let response: Response;
  try {
    response = await githubApiFetch(
      config.apiBaseUrl,
      `/repos/${owner}/${repoName}/contents/${encodeNotePath(notePath)}`,
      auth.token,
      { method: 'PUT', body: JSON.stringify(githubBody) },
    );
  } catch {
    return githubUnreachable();
  }

  if (response.status === 409) {
    // sha 楽観ロック競合（リモートが読込時から変更されている）。UI が Conflict を
    // 識別できるよう error: 'conflict' でそのまま伝える（データ損失を防ぐ防衛線）
    const githubBodyText = await response.json().catch(() => null);
    const message =
      typeof githubBodyText === 'object' &&
      githubBodyText !== null &&
      typeof (githubBodyText as { message?: unknown }).message === 'string'
        ? (githubBodyText as { message: string }).message
        : 'リモートの内容が変更されています。';
    return Response.json({ error: 'conflict', message }, { status: 409 });
  }

  const failure = mapGithubFailure(response);
  if (failure) {
    return failure;
  }

  const savedBody = (await response.json().catch(() => null)) as {
    content?: { sha?: unknown };
  } | null;
  const savedSha = savedBody?.content?.sha;
  if (typeof savedSha !== 'string' || savedSha.length === 0) {
    return Response.json({ error: 'github_error' }, { status: 502 });
  }

  return Response.json(
    {
      owner,
      name: repoName,
      path: notePath,
      sha: savedSha,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};
