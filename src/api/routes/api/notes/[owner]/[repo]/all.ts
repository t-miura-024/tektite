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
import { listCachedNotes, readVaultMeta, writeCachedNote } from '@/api/_lib/r2-vault';

interface GithubRepoInfo {
  default_branch?: unknown;
}

interface GithubTreeEntry {
  path?: unknown;
  type?: unknown;
  sha?: unknown;
}

interface GithubTreeResponse {
  truncated?: unknown;
  tree?: GithubTreeEntry[];
}

interface GithubBlobResponse {
  content?: unknown;
  encoding?: unknown;
}

/** Blob 並列取得の同時実行上限（GitHub のレートリミット消費を抑える） */
const BLOB_FETCH_CONCURRENCY = 8;

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
 * 失敗を null に握りつぶすことで、1 ノートの失敗が一括取得全体を落とさない。
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
  const body = (await response.json().catch(() => null)) as GithubBlobResponse | null;
  if (!body || body.encoding !== 'base64' || typeof body.content !== 'string') {
    return null;
  }
  return decodeBase64Content(body.content);
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

  // R2 が正: 初期同期済み（メタあり）の Vault は R2 上の全ノートを返す
  // （Vault を開くだけでは GitHub API を消費しない。同期済みのため網羅性は
  // 初期同期が保証し、GitHub 側の追加分は M5 のツリー sha 比較で同期される）
  const bucket = env.VAULT_BUCKET;
  if (bucket) {
    const meta = await readVaultMeta(bucket, owner, repoName);
    if (meta !== null) {
      const cachedNotes = await listCachedNotes(bucket, owner, repoName);
      return Response.json(
        {
          owner,
          name: repoName,
          defaultBranch: meta.defaultBranch,
          truncated: false,
          notes: cachedNotes.map(({ path, note }) => ({
            path,
            sha: note.sha,
            content: note.content,
          })),
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  // 1) リポジトリ情報からデフォルトブランチを解決する（/api/tree と同じ）
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
  const defaultBranch = repoInfo.default_branch;

  // 2) ツリー全体を取得し、Markdown blob の path + sha を抽出する
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
  if (treeFailure) {
    // コミットが 1 つもない空リポジトリは Trees API が 404 を返す（GitHub 実挙動）。
    // リポジトリ自体は上で取得成功済みなので、空のノート列として扱う（M2）
    if (treeResponse.status === 404) {
      return Response.json(
        { owner, name: repoName, defaultBranch, truncated: false, notes: [] },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return treeFailure;
  }
  const treeBody = (await treeResponse.json().catch(() => null)) as GithubTreeResponse | null;
  if (!treeBody || !Array.isArray(treeBody.tree)) {
    return Response.json({ error: 'github_error' }, { status: 502 });
  }

  const noteBlobs: { path: string; sha: string }[] = [];
  for (const entry of treeBody.tree) {
    if (entry.type !== 'blob') {
      continue;
    }
    if (typeof entry.path !== 'string' || !entry.path.endsWith('.md')) {
      continue;
    }
    if (typeof entry.sha !== 'string' || entry.sha.length === 0) {
      continue;
    }
    noteBlobs.push({ path: entry.path, sha: entry.sha });
  }

  // 遅延キャッシュ: 初期同期済み Vault は、GitHub から取得したノートを R2 へ
  // 書き戻す（メタなし = 未同期の Vault は書き込まない）
  let shouldCache = false;
  if (bucket) {
    const meta = await readVaultMeta(bucket, owner, repoName);
    shouldCache = meta !== null;
  }

  // 3) Blob を同時 8 件ずつ取得する（取得失敗ノートは索引から欠落させる）
  const notes: { path: string; sha: string; content: string }[] = [];
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
      notes.push(result);
      if (shouldCache && bucket) {
        // oxlint-disable-next-line no-await-in-loop -- 取得済みノートの R2 書き込み（チャンク内で順次実行）のため
        await writeCachedNote(bucket, owner, repoName, result.path, {
          sha: result.sha,
          content: result.content,
        });
      }
    }
  }

  return Response.json(
    {
      owner,
      name: repoName,
      defaultBranch,
      truncated: treeBody.truncated === true,
      notes,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export const GET = createRoute((c) =>
  handleNotesAllGet({ env: c.env as Env, request: c.req.raw, params: c.req.param() }),
);
