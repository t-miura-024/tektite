/**
 * GitHubへの一括コミット（Blobs→Trees→Commits→refsの順に適用）。
 * 同期のpushと未同期Vaultの直接コミットで共用し、デフォルトブランチへ単一コミットを作る。
 * moveは既存blobを再利用し同一パスは後勝ち。空リポジトリは初回扱いで参照を新規作成し、
 * ref更新の409は楽観ロック競合としてconflictを返す。
 */

import { githubApiFetch, githubUnreachable, mapGithubFailure } from '@/api/_lib/github-proxy';
import {
  buildDelta,
  createBlobs,
  type DeltaEntry,
  type ParsedChange,
} from '@/api/_lib/github-commit-delta';
import { readBranchState, resolveDefaultBranch } from '@/api/_lib/github-commit-state';
import { readJsonBody, readNonEmptyStringField } from '@/api/_lib/github-json';

export type { ParsedChange };

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
  const repo = await resolveDefaultBranch(base, token, owner, repoName);
  if (!repo.ok) {
    return repo;
  }
  const state = await readBranchState(base, token, owner, repoName, repo.branch);
  if (!state.ok) {
    return state;
  }

  // 差分エントリを組み立て、create/update の Blob を並列作成する
  // （同一パスの後続変更が勝つ。move 後の update で張り替え後本文が反映される）
  const built = buildDelta(changes, state.state.blobShaByPath);
  if (!built.ok) {
    return built;
  }
  const blobResults = await createBlobs(base, token, owner, repoName, built.blobOps);
  for (const result of blobResults) {
    if (!result.ok) {
      return { ok: false, response: result.error };
    }
    const entry: DeltaEntry = {
      path: result.path,
      mode: '100644',
      type: 'blob',
      sha: result.sha,
    };
    built.delta.set(result.path, entry);
  }

  // 新 tree を作成する（base_tree を継承。空リポジトリの初回コミットは省略）
  const treeFetched = await fetchApi(base, `/repos/${owner}/${repoName}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify(
      state.state.baseTreeSha === null
        ? { tree: [...built.delta.values()] }
        : { base_tree: state.state.baseTreeSha, tree: [...built.delta.values()] },
    ),
  });
  if (!treeFetched.ok) {
    return treeFetched;
  }
  const treeFailure = mapGithubFailure(treeFetched.response);
  if (treeFailure) {
    return { ok: false, response: treeFailure };
  }
  const treeSha = readNonEmptyStringField(await readJsonBody(treeFetched.response), 'sha');
  if (treeSha === null) {
    return { ok: false, response: githubErrorResponse() };
  }
  // コミットを作成する（空リポジトリの初回コミットは parents 無し）
  const commitFetched = await fetchApi(base, `/repos/${owner}/${repoName}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({
      message,
      tree: treeSha,
      parents: state.state.headCommitSha === null ? [] : [state.state.headCommitSha],
    }),
  });
  if (!commitFetched.ok) {
    return commitFetched;
  }
  const commitFailure = mapGithubFailure(commitFetched.response);
  if (commitFailure) {
    return { ok: false, response: commitFailure };
  }
  const commitSha = readNonEmptyStringField(await readJsonBody(commitFetched.response), 'sha');
  if (commitSha === null) {
    return { ok: false, response: githubErrorResponse() };
  }
  const refFetched = await fetchApi(
    base,
    `/repos/${owner}/${repoName}/git/refs/heads/${encodeURIComponent(repo.branch)}`,
    token,
    {
      method: 'PATCH',
      body: JSON.stringify({ sha: commitSha, force: false }),
    },
  );
  if (!refFetched.ok) {
    return refFetched;
  }
  if (refFetched.response.status === 409) {
    return { ok: false, response: conflictResponse() };
  }
  if (refFetched.response.status === 404) {
    const firstRefFetched = await fetchApi(base, `/repos/${owner}/${repoName}/git/refs`, token, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${repo.branch}`, sha: commitSha }),
    });
    if (!firstRefFetched.ok) {
      return firstRefFetched;
    }
    if (firstRefFetched.response.status === 409) {
      return { ok: false, response: conflictResponse() };
    }
    const firstFailure = mapGithubFailure(firstRefFetched.response);
    if (firstFailure) {
      return { ok: false, response: firstFailure };
    }
    return { ok: true, branch: repo.branch, commitSha };
  }
  const refFailure = mapGithubFailure(refFetched.response);
  if (refFailure) {
    return { ok: false, response: refFailure };
  }
  return { ok: true, branch: repo.branch, commitSha };
}

const conflictResponse = (): Response => Response.json({ error: 'conflict' }, { status: 409 });

const githubErrorResponse = (): Response =>
  Response.json({ error: 'github_error' }, { status: 502 });

/** fetch の失敗を github_unreachable（502）に変換して fetch する */
async function fetchApi(
  base: string,
  path: string,
  token: string,
  init?: { method?: string; body?: string },
): Promise<
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly response: Response }
> {
  try {
    return { ok: true, response: await githubApiFetch(base, path, token, init) };
  } catch {
    return { ok: false, response: githubUnreachable() };
  }
}
