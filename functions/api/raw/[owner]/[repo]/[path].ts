/**
 * 画像・添付ファイルの raw 配信: GET /api/raw/:owner/:repo/:path
 *
 * `![[画像.png]]` の表示（M2 リーディング表示）用。GitHub Contents API を
 * `Accept: application/vnd.github.raw` で呼び、バイナリ本文をそのまま返す。
 * トークンは Workers 側のみ保持のため、raw.githubusercontent.com ではなく
 * プロキシ経由で配信する（プライベートリポジトリの画像も表示できる）。
 *
 * パスはノート取得（/api/notes）と同じく、パス全体（/ 区切り）を 1 セグメント
 * にパーセントエンコードして受け取る（例: attachments%2Flogo.png）。
 * パラメータは実行環境によりデコード済みの場合があるため、decodeSegment が
 * 二重デコードを防ぎながら元のパスを復元する。
 *
 * 応答:
 * - パラメータ不正                 → 400 { error: 'invalid_vault_ref' | 'invalid_raw_path' }
 * - 未ログイン                     → 401 { error: 'unauthenticated' }
 * - ファイルが見つからない          → 404 { error: 'not_found' }
 * - レートリミット（403 / 429）    → 429 { error: 'rate_limited' }
 * - 正常                           → 200（バイナリ本文 + Content-Type）
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

/** パスパラメータを文字列に正規化する（配列で渡された場合は先頭を採用） */
function paramToString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/** パスセグメントの URL デコード（不正なパーセントエスケープは元の文字列を採用） */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** パスパラメータ（パス全体を 1 セグメントにエンコードしたもの）をパスに復元する */
function resolveRawPath(value: string | string[] | undefined): string | null {
  const rawPath = paramToString(value);
  const path = decodeSegment(rawPath)
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/');
  return path.length === 0 ? null : path;
}

/** パスを Contents API の URL パス（セグメント単位でエンコード）に変換する */
function encodeRawPath(rawPath: string): string {
  return rawPath
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

  const rawPath = resolveRawPath(params.path);
  if (rawPath === null) {
    return Response.json({ error: 'invalid_raw_path' }, { status: 400 });
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

  let response: Response;
  try {
    response = await githubApiFetch(
      config.apiBaseUrl,
      `/repos/${owner}/${repoName}/contents/${encodeRawPath(rawPath)}`,
      auth.token,
      { headers: { Accept: 'application/vnd.github.raw' } },
    );
  } catch {
    return githubUnreachable();
  }
  const failure = mapGithubFailure(response);
  if (failure) {
    return failure;
  }

  // 画像はコミットで更新されうるが、短期キャッシュで API 呼び出しを抑える
  const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream';
  return new Response(response.body, {
    headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=300' },
  });
};
