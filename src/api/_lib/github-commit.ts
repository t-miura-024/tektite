/**
 * GitHub への一括コミット（Git Blobs → Trees → Commits → refs の流れ）。
 *
 * M4 で書き込み経路が R2 先行化された後も、同期（M5 の定時/明示同期）の
 * push はこのフローを再利用する（計画方針 4: 同期の push は既存の commit
 * フローを再利用する）。一括コミット API（POST /api/files/:owner/:repo/commit）
 * は未同期（R2 メタなし）Vault に対してこのフローで GitHub へ直接コミットする。
 *
 * 流れ（すべてデフォルトブランチに対して）:
 * リポジトリ情報（デフォルトブランチ解決）→ ref（先頭コミット sha）→
 * Trees API（base tree sha + パス → blob sha の対応）→ 新規 Blob 作成 →
 * 新規 Tree 作成（base_tree を継承して差分エントリを適用）→ Commit 作成 →
 * ref 更新（force: false）。ref 更新が 409 の場合は楽観ロック競合として
 * `{ error: 'conflict' }` を返す。
 *
 * 空リポジトリ（コミット 0 件）対応: コミットが無いと ref / trees が 404 を
 * 返すため、parents 無し・base_tree 無しの初回コミットとして扱い、ref 更新
 * （PATCH）も 404 になるため POST /git/refs でブランチ参照を新規作成する。
 */

import { githubApiFetch, githubUnreachable, mapGithubFailure } from '@/api/_lib/github-proxy';

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

/** コミット変更 1 件（ボディ検証後の正規化形） */
export interface ParsedChange {
  readonly op: 'create' | 'update' | 'delete' | 'move' | 'copy';
  readonly path: string;
  /** move / copy の移動・複製先（他 op は null） */
  readonly to: string | null;
  /** create/update の本文 base64（他 op は null） */
  readonly content: string | null;
}

/** GitHub への一括コミットの結果（失敗時は完成済みのエラー応答を返す） */
export type CommitToGithubResult =
  | { readonly ok: true; readonly branch: string; readonly commitSha: string }
  | { readonly ok: false; readonly response: Response };

/**
 * 変更列を単一コミットとして GitHub のデフォルトブランチへ適用する。
 * move は base tree の blob sha を再利用（本文転送なし）、同一パスの後続変更が
 * 勝つ（delta Map の後勝ち）。認証・パラメータ検証は呼び出し側の責務。
 */
export async function commitChangesToGitHub(
  base: string,
  token: string,
  owner: string,
  repoName: string,
  changes: readonly ParsedChange[],
  message: string,
): Promise<CommitToGithubResult> {
  // 1) リポジトリ情報からデフォルトブランチを解決する
  let repoResponse: Response;
  try {
    repoResponse = await githubApiFetch(base, `/repos/${owner}/${repoName}`, token);
  } catch {
    return { ok: false, response: githubUnreachable() };
  }
  const repoFailure = mapGithubFailure(repoResponse);
  if (repoFailure) {
    return { ok: false, response: repoFailure };
  }
  const repoInfo = (await repoResponse.json().catch(() => null)) as GithubRepoInfo | null;
  if (
    !repoInfo ||
    typeof repoInfo.default_branch !== 'string' ||
    repoInfo.default_branch.length === 0
  ) {
    return { ok: false, response: Response.json({ error: 'github_error' }, { status: 502 }) };
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
    return { ok: false, response: githubUnreachable() };
  }
  const refFailure = mapGithubFailure(refResponse);
  if (refFailure && refResponse.status !== 404) {
    return { ok: false, response: refFailure };
  }
  let headCommitSha: string | null = null;
  if (refResponse.status !== 404) {
    const refBody = (await refResponse.json().catch(() => null)) as GithubRefResponse | null;
    if (typeof refBody?.object?.sha !== 'string' || refBody.object.sha.length === 0) {
      return { ok: false, response: Response.json({ error: 'github_error' }, { status: 502 }) };
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
    return { ok: false, response: githubUnreachable() };
  }
  const treeFailure = mapGithubFailure(treeResponse);
  if (treeFailure && treeResponse.status !== 404) {
    return { ok: false, response: treeFailure };
  }
  let baseTreeSha: string | null = null;
  const blobShaByPath = new Map<string, string>();
  if (treeResponse.status !== 404) {
    const treeBody = (await treeResponse.json().catch(() => null)) as GithubTreeResponse | null;
    if (typeof treeBody?.sha !== 'string' || !Array.isArray(treeBody.tree)) {
      return { ok: false, response: Response.json({ error: 'github_error' }, { status: 502 }) };
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
  for (const change of changes) {
    if (change.op === 'create' || change.op === 'update') {
      if (change.content === null) {
        // 呼び出し側の検証（parseCommitBody）で保証されるため到達しない（型の防御線）
        return {
          ok: false,
          response: Response.json({ error: 'invalid_body' }, { status: 400 }),
        };
      }
      blobOps.push({ path: change.path, content: change.content });
    } else if (change.op === 'delete') {
      delta.set(change.path, { path: change.path, mode: '100644', type: 'blob', sha: null });
    } else if (change.op === 'move') {
      // move: base tree の blob sha を再利用して移動先に引き継ぎ、元パスを削除する
      if (change.to === null) {
        // 呼び出し側の検証で保証されるため到達しない（型の防御線）
        return {
          ok: false,
          response: Response.json({ error: 'invalid_body' }, { status: 400 }),
        };
      }
      const sourceSha = blobShaByPath.get(change.path);
      if (!sourceSha) {
        return {
          ok: false,
          response: Response.json(
            { error: 'invalid_change', message: `移動元「${change.path}」が見つかりません。` },
            { status: 400 },
          ),
        };
      }
      delta.set(change.to, { path: change.to, mode: '100644', type: 'blob', sha: sourceSha });
      delta.set(change.path, { path: change.path, mode: '100644', type: 'blob', sha: null });
    } else {
      // copy: base tree の blob sha を再利用して複製先に置く（元パスは残す）
      if (change.to === null) {
        // 呼び出し側の検証で保証されるため到達しない（型の防御線）
        return {
          ok: false,
          response: Response.json({ error: 'invalid_body' }, { status: 400 }),
        };
      }
      const sourceSha = blobShaByPath.get(change.path);
      if (!sourceSha) {
        return {
          ok: false,
          response: Response.json(
            { error: 'invalid_change', message: `複製元「${change.path}」が見つかりません。` },
            { status: 400 },
          ),
        };
      }
      delta.set(change.to, { path: change.to, mode: '100644', type: 'blob', sha: sourceSha });
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
      return { ok: false, response: result.error };
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
    return { ok: false, response: githubUnreachable() };
  }
  const newTreeFailure = mapGithubFailure(newTreeResponse);
  if (newTreeFailure) {
    return { ok: false, response: newTreeFailure };
  }
  const newTreeBody = (await newTreeResponse.json().catch(() => null)) as GithubTreeResponse | null;
  if (typeof newTreeBody?.sha !== 'string' || newTreeBody.sha.length === 0) {
    return { ok: false, response: Response.json({ error: 'github_error' }, { status: 502 }) };
  }

  // 6) コミットを作成する（parents はブランチ先頭コミットのみ。
  //    空リポジトリの初回コミットは parents 無し）
  let commitResponse: Response;
  try {
    commitResponse = await githubApiFetch(base, `/repos/${owner}/${repoName}/git/commits`, token, {
      method: 'POST',
      body: JSON.stringify({
        message,
        tree: newTreeBody.sha,
        parents: isFirstCommit ? [] : [headCommitSha],
      }),
    });
  } catch {
    return { ok: false, response: githubUnreachable() };
  }
  const commitFailure = mapGithubFailure(commitResponse);
  if (commitFailure) {
    return { ok: false, response: commitFailure };
  }
  const commitBody = (await commitResponse.json().catch(() => null)) as GithubCommitResponse | null;
  if (typeof commitBody?.sha !== 'string' || commitBody.sha.length === 0) {
    return { ok: false, response: Response.json({ error: 'github_error' }, { status: 502 }) };
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
    return { ok: false, response: githubUnreachable() };
  }
  if (updateRefResponse.status === 409) {
    return { ok: false, response: Response.json({ error: 'conflict' }, { status: 409 }) };
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
      return { ok: false, response: githubUnreachable() };
    }
    if (createRefResponse.status === 409) {
      return { ok: false, response: Response.json({ error: 'conflict' }, { status: 409 }) };
    }
    const createRefFailure = mapGithubFailure(createRefResponse);
    if (createRefFailure) {
      return { ok: false, response: createRefFailure };
    }
  } else {
    const updateRefFailure = mapGithubFailure(updateRefResponse);
    if (updateRefFailure) {
      return { ok: false, response: updateRefFailure };
    }
  }

  return { ok: true, branch, commitSha: commitBody.sha };
}
