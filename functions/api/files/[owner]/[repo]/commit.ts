/**
 * 一括コミット: POST /api/files/:owner/:repo/commit
 *
 * 複数ファイルの変更（作成/更新/削除/移動）を Git Trees/Blobs API で必ず
 * 単一コミットに束ねて適用する（M5 方針 2。リネーム/移動に伴うリンク張り替えも
 * このエンドポイントで 1 コミットになる）。
 *
 * body: `{ changes: [{ op, path, to?, content? }], message }`
 * - op 'create' / 'update': path に content（base64）を置く
 * - op 'delete': path のファイルを削除する（tree エントリに sha: null）
 * - op 'move': path（from）を to へ移動する。本文は送らず、GitHub 上の
 *   既存 blob sha を base tree から引いて再利用する（添付ファイルなど
 *   クライアントに本文を持たないファイルも移動できる）
 * - message: コミットメッセージ（必須）
 *
 * 流れ（すべてデフォルトブランチに対して）:
 * リポジトリ情報（デフォルトブランチ解決）→ ref（先頭コミット sha）→
 * Trees API（base tree sha + パス → blob sha の対応）→ 新規 Blob 作成 →
 * 新規 Tree 作成（base_tree を継承して差分エントリを適用）→ Commit 作成 →
 * ref 更新（force: false）。ref 更新が 409 の場合は楽観ロック競合として
 * `{ error: 'conflict' }` を返す（ノート保存の sha 楽観ロックと同系の防衛線）。
 *
 * 空リポジトリ（コミット 0 件）対応（M2）: コミットが無いと ref / trees が 404 を
 * 返すため、parents 無し・base_tree 無しの初回コミットとして扱う。ref 更新
 * （PATCH）も 404 になるため、POST /git/refs でブランチ参照を新規作成する。
 *
 * 応答:
 * - パラメータ不正                  → 400 { error: 'invalid_vault_ref' }
 * - ボディ不正                      → 400 { error: 'invalid_body' }
 * - 移動元が base tree にない        → 400 { error: 'invalid_change' }
 * - 未ログイン                      → 401 { error: 'unauthenticated' }
 * - レートリミット（403 / 429）     → 429 { error: 'rate_limited' }
 * - ブランチ競合（ref 更新 409）     → 409 { error: 'conflict' }
 * - 正常                            → 200 { owner, name, branch, commitSha }
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

interface GithubRepoInfo {
  default_branch?: unknown;
}

interface GithubRefResponse {
  object?: { sha?: unknown };
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

interface GithubBlobResponse {
  sha?: unknown;
}

interface GithubCommitResponse {
  sha?: unknown;
}

/** 1 リクエストで受け付ける変更の上限（個人 Vault 規模の防衛線） */
const MAX_CHANGES = 500;

/** パスパラメータを文字列に正規化する（配列で渡された場合は先頭を採用） */
function paramToString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/** パスのセグメント検証（空セグメント・. / .. ・前後スラッシュを拒否） */
function isValidEntryPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.endsWith('/')) {
    return false;
  }
  return path
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** 標準 base64（btoa 出力相当）かどうか。空文字（空ファイル）も許容する */
function isValidBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

/** コミット変更 1 件（ボディ検証後の正規化形） */
interface ParsedChange {
  readonly op: 'create' | 'update' | 'delete' | 'move';
  readonly path: string;
  /** move の移動先（他 op は null） */
  readonly to: string | null;
  /** create/update の本文 base64（他 op は null） */
  readonly content: string | null;
}

/** ボディを検証し、変更列とメッセージへ正規化する（不正は null） */
function parseCommitBody(raw: unknown): { changes: ParsedChange[]; message: string } | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const body = raw as { changes?: unknown; message?: unknown };
  if (typeof body.message !== 'string' || body.message.length === 0) {
    return null;
  }
  if (
    !Array.isArray(body.changes) ||
    body.changes.length === 0 ||
    body.changes.length > MAX_CHANGES
  ) {
    return null;
  }
  const changes: ParsedChange[] = [];
  for (const item of body.changes) {
    if (typeof item !== 'object' || item === null) {
      return null;
    }
    const change = item as { op?: unknown; path?: unknown; to?: unknown; content?: unknown };
    if (
      change.op !== 'create' &&
      change.op !== 'update' &&
      change.op !== 'delete' &&
      change.op !== 'move'
    ) {
      return null;
    }
    if (typeof change.path !== 'string' || !isValidEntryPath(change.path)) {
      return null;
    }
    if (change.op === 'move') {
      if (
        typeof change.to !== 'string' ||
        !isValidEntryPath(change.to) ||
        change.to === change.path
      ) {
        return null;
      }
      changes.push({ op: 'move', path: change.path, to: change.to, content: null });
      continue;
    }
    if (change.op === 'delete') {
      changes.push({ op: 'delete', path: change.path, to: null, content: null });
      continue;
    }
    if (typeof change.content !== 'string' || !isValidBase64(change.content)) {
      return null;
    }
    changes.push({ op: change.op, path: change.path, to: null, content: change.content });
  }
  return { changes, message: body.message };
}

export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
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

  const body = parseCommitBody(await request.json().catch(() => null));
  if (body === null) {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  const base = config.apiBaseUrl;
  const token = auth.token;

  // 1) リポジトリ情報からデフォルトブランチを解決する
  let repoResponse: Response;
  try {
    repoResponse = await githubApiFetch(base, `/repos/${owner}/${repoName}`, token);
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
  const branch = repoInfo.default_branch;

  // 2) ブランチ先頭コミットの sha を取得する（Commit 作成時の parents に使う）。
  //    404 はコミット 0 件の空リポジトリ（初回コミット。parents 無しで作る）
  let refResponse: Response;
  try {
    refResponse = await githubApiFetch(
      base,
      `/repos/${owner}/${repoName}/git/ref/heads/${encodeURIComponent(branch)}`,
      token,
    );
  } catch {
    return githubUnreachable();
  }
  const refFailure = mapGithubFailure(refResponse);
  if (refFailure && refResponse.status !== 404) {
    return refFailure;
  }
  let headCommitSha: string | null = null;
  if (refResponse.status !== 404) {
    const refBody = (await refResponse.json().catch(() => null)) as GithubRefResponse | null;
    if (typeof refBody?.object?.sha !== 'string' || refBody.object.sha.length === 0) {
      return Response.json({ error: 'github_error' }, { status: 502 });
    }
    headCommitSha = refBody.object.sha;
  }
  const isFirstCommit = headCommitSha === null;

  // 3) base tree（パス → blob sha の対応）を取得する。move の本文引き継ぎと
  //    新 tree の base_tree に使う（ref 名で Trees API を直接引ける）。
  //    空リポジトリは 404 のため base tree 無し（base_tree を省略して作る）
  let treeResponse: Response;
  try {
    treeResponse = await githubApiFetch(
      base,
      `/repos/${owner}/${repoName}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      token,
    );
  } catch {
    return githubUnreachable();
  }
  const treeFailure = mapGithubFailure(treeResponse);
  if (treeFailure && treeResponse.status !== 404) {
    return treeFailure;
  }
  let baseTreeSha: string | null = null;
  const blobShaByPath = new Map<string, string>();
  if (treeResponse.status !== 404) {
    const treeBody = (await treeResponse.json().catch(() => null)) as GithubTreeResponse | null;
    if (typeof treeBody?.sha !== 'string' || !Array.isArray(treeBody.tree)) {
      return Response.json({ error: 'github_error' }, { status: 502 });
    }
    baseTreeSha = treeBody.sha;
    for (const entry of treeBody.tree) {
      if (
        entry.type === 'blob' &&
        typeof entry.path === 'string' &&
        typeof entry.sha === 'string'
      ) {
        blobShaByPath.set(entry.path, entry.sha);
      }
    }
  }

  // 4) create/update の Blob を作成し、差分エントリ（path → 内容）を組み立てる。
  //    同一パスの後続変更が勝つ（move 後の update で張り替え後本文が反映される）
  interface DeltaEntry {
    readonly path: string;
    readonly mode: string;
    readonly type: 'blob';
    readonly sha: string | null;
  }
  const delta = new Map<string, DeltaEntry>();
  // create/update は Blob 作成が要るため対象を一旦集め（順序保持）、
  // move/delete は即座に差分エントリへ反映する
  const blobOps: { readonly path: string; readonly content: string }[] = [];
  for (const change of body.changes) {
    if (change.op === 'create' || change.op === 'update') {
      if (change.content === null) {
        // parseCommitBody で保証されるため到達しない（型の防御線）
        return Response.json({ error: 'invalid_body' }, { status: 400 });
      }
      blobOps.push({ path: change.path, content: change.content });
    } else if (change.op === 'delete') {
      delta.set(change.path, { path: change.path, mode: '100644', type: 'blob', sha: null });
    } else {
      // move: base tree の blob sha を再利用して移動先に引き継ぎ、元パスを削除する
      if (change.to === null) {
        // parseCommitBody で保証されるため到達しない（型の防御線）
        return Response.json({ error: 'invalid_body' }, { status: 400 });
      }
      const sourceSha = blobShaByPath.get(change.path);
      if (!sourceSha) {
        return Response.json(
          { error: 'invalid_change', message: `移動元「${change.path}」が見つかりません。` },
          { status: 400 },
        );
      }
      delta.set(change.to, { path: change.to, mode: '100644', type: 'blob', sha: sourceSha });
      delta.set(change.path, { path: change.path, mode: '100644', type: 'blob', sha: null });
    }
  }
  // 独立パスの Blob 作成は並列化する（順序依存はなく、同一パスの後勝ちは
  // blobOps の並び順で下の delta.set が担保する）
  type BlobResult =
    | { readonly ok: true; readonly path: string; readonly sha: string }
    | { readonly ok: false; readonly error: Response };
  const blobResults: BlobResult[] = await Promise.all(
    blobOps.map(async ({ path, content }): Promise<BlobResult> => {
      let blobResponse: Response;
      try {
        blobResponse = await githubApiFetch(base, `/repos/${owner}/${repoName}/git/blobs`, token, {
          method: 'POST',
          body: JSON.stringify({ content, encoding: 'base64' }),
        });
      } catch {
        return { ok: false, error: githubUnreachable() };
      }
      const blobFailure = mapGithubFailure(blobResponse);
      if (blobFailure) {
        return { ok: false, error: blobFailure };
      }
      const blobBody = (await blobResponse.json().catch(() => null)) as GithubBlobResponse | null;
      if (typeof blobBody?.sha !== 'string' || blobBody.sha.length === 0) {
        return { ok: false, error: Response.json({ error: 'github_error' }, { status: 502 }) };
      }
      return { ok: true, path, sha: blobBody.sha };
    }),
  );
  for (const result of blobResults) {
    if (!result.ok) {
      return result.error;
    }
    delta.set(result.path, { path: result.path, mode: '100644', type: 'blob', sha: result.sha });
  }

  // 5) 新 tree を作成する（base_tree を継承し、差分エントリを適用。
  //    空リポジトリの初回コミットは base_tree を省略する）
  let newTreeResponse: Response;
  try {
    newTreeResponse = await githubApiFetch(base, `/repos/${owner}/${repoName}/git/trees`, token, {
      method: 'POST',
      body: JSON.stringify(
        baseTreeSha === null
          ? { tree: [...delta.values()] }
          : { base_tree: baseTreeSha, tree: [...delta.values()] },
      ),
    });
  } catch {
    return githubUnreachable();
  }
  const newTreeFailure = mapGithubFailure(newTreeResponse);
  if (newTreeFailure) {
    return newTreeFailure;
  }
  const newTreeBody = (await newTreeResponse.json().catch(() => null)) as GithubTreeResponse | null;
  if (typeof newTreeBody?.sha !== 'string' || newTreeBody.sha.length === 0) {
    return Response.json({ error: 'github_error' }, { status: 502 });
  }

  // 6) コミットを作成する（parents はブランチ先頭コミットのみ。
  //    空リポジトリの初回コミットは parents 無し）
  let commitResponse: Response;
  try {
    commitResponse = await githubApiFetch(base, `/repos/${owner}/${repoName}/git/commits`, token, {
      method: 'POST',
      body: JSON.stringify({
        message: body.message,
        tree: newTreeBody.sha,
        parents: isFirstCommit ? [] : [headCommitSha],
      }),
    });
  } catch {
    return githubUnreachable();
  }
  const commitFailure = mapGithubFailure(commitResponse);
  if (commitFailure) {
    return commitFailure;
  }
  const commitBody = (await commitResponse.json().catch(() => null)) as GithubCommitResponse | null;
  if (typeof commitBody?.sha !== 'string' || commitBody.sha.length === 0) {
    return Response.json({ error: 'github_error' }, { status: 502 });
  }

  // 7) ブランチ参照を更新する（force: false。409 は楽観ロック競合として伝える）。
  //    空リポジトリの初回コミットは PATCH が 404（ref 未作成）になるため、
  //    POST /git/refs で新規作成する
  let updateRefResponse: Response;
  try {
    updateRefResponse = await githubApiFetch(
      base,
      `/repos/${owner}/${repoName}/git/refs/heads/${encodeURIComponent(branch)}`,
      token,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha: commitBody.sha, force: false }),
      },
    );
  } catch {
    return githubUnreachable();
  }
  if (updateRefResponse.status === 409) {
    return Response.json({ error: 'conflict' }, { status: 409 });
  }
  if (updateRefResponse.status === 404 && isFirstCommit) {
    let createRefResponse: Response;
    try {
      createRefResponse = await githubApiFetch(
        base,
        `/repos/${owner}/${repoName}/git/refs`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitBody.sha }),
        },
      );
    } catch {
      return githubUnreachable();
    }
    if (createRefResponse.status === 409) {
      return Response.json({ error: 'conflict' }, { status: 409 });
    }
    const createRefFailure = mapGithubFailure(createRefResponse);
    if (createRefFailure) {
      return createRefFailure;
    }
  } else {
    const updateRefFailure = mapGithubFailure(updateRefResponse);
    if (updateRefFailure) {
      return updateRefFailure;
    }
  }

  return Response.json(
    { owner, name: repoName, branch, commitSha: commitBody.sha },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};
