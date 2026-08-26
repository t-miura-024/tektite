/**
 * GitHub への一括コミット（Git Blobs → Trees → Commits → refs の流れ）。
 *
 * M4 で書き込み経路が R2 先行化された後も、同期（M5 の定時/明示同期）の
 * push はこのフローを再利用する（計画方針 4: 同期の push は既存の commit
 * フローを再利用する）。一括コミット API（POST /api/files/:owner/:repo/commit）
 * は未同期（R2 メタなし）Vault に対してこのフローで GitHub へ直接コミットする。
 *
 * 流れ（すべてデフォルトブランチに対して）:
 * リポジトリ情報 → ref / Trees API の状態読み取り（github-commit-state）→
 * 差分エントリ組み立て + Blob 作成（github-commit-delta）→ 新規 Tree 作成 →
 * Commit 作成 → ref 更新（force: false）。ref 更新が 409 の場合は楽観ロック競合として
 * `{ error: 'conflict' }` を返す。空リポジトリは parents 無し・base_tree 無しの
 * 初回コミットとして扱い、ref 更新（PATCH）が 404 のため POST /git/refs で
 * ブランチ参照を新規作成する。
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

/** ステップの共通失敗形（CommitToGithubResult の失敗側と同じ構造） */
type StepError = { readonly ok: false; readonly response: Response };

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
  const treeSha = await createTree(
    base,
    token,
    owner,
    repoName,
    state.state.baseTreeSha,
    built.delta,
  );
  if (!treeSha.ok) {
    return treeSha;
  }
  // コミットを作成する（空リポジトリの初回コミットは parents 無し）
  const commit = await createCommit(
    base,
    token,
    owner,
    repoName,
    message,
    treeSha.sha,
    state.state.headCommitSha,
  );
  if (!commit.ok) {
    return commit;
  }
  return updateBranchRef(base, token, owner, repoName, repo.branch, commit.sha);
}

/** 新 tree を作成し、tree sha を返す */
async function createTree(
  base: string,
  token: string,
  owner: string,
  repoName: string,
  baseTreeSha: string | null,
  delta: ReadonlyMap<string, DeltaEntry>,
): Promise<{ ok: true; sha: string } | StepError> {
  const fetched = await fetchApi(base, `/repos/${owner}/${repoName}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify(
      baseTreeSha === null
        ? { tree: [...delta.values()] }
        : { base_tree: baseTreeSha, tree: [...delta.values()] },
    ),
  });
  if (!fetched.ok) {
    return fetched;
  }
  const failure = mapGithubFailure(fetched.response);
  if (failure) {
    return { ok: false, response: failure };
  }
  const sha = readNonEmptyStringField(await readJsonBody(fetched.response), 'sha');
  if (sha === null) {
    return { ok: false, response: githubErrorResponse() };
  }
  return { ok: true, sha };
}

/** コミットを作成し、commit sha を返す */
async function createCommit(
  base: string,
  token: string,
  owner: string,
  repoName: string,
  message: string,
  treeSha: string,
  headCommitSha: string | null,
): Promise<{ ok: true; sha: string } | StepError> {
  const fetched = await fetchApi(base, `/repos/${owner}/${repoName}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({
      message,
      tree: treeSha,
      parents: headCommitSha === null ? [] : [headCommitSha],
    }),
  });
  if (!fetched.ok) {
    return fetched;
  }
  const failure = mapGithubFailure(fetched.response);
  if (failure) {
    return { ok: false, response: failure };
  }
  const sha = readNonEmptyStringField(await readJsonBody(fetched.response), 'sha');
  if (sha === null) {
    return { ok: false, response: githubErrorResponse() };
  }
  return { ok: true, sha };
}

/**
 * ブランチ参照を更新する（force: false。409 は楽観ロック競合として伝える）。
 * 空リポジトリの初回コミットは PATCH が 404（ref 未作成）になるため、
 * POST /git/refs で新規作成する。
 */
async function updateBranchRef(
  base: string,
  token: string,
  owner: string,
  repoName: string,
  branch: string,
  commitSha: string,
): Promise<CommitToGithubResult> {
  const fetched = await fetchApi(
    base,
    `/repos/${owner}/${repoName}/git/refs/heads/${encodeURIComponent(branch)}`,
    token,
    {
      method: 'PATCH',
      body: JSON.stringify({ sha: commitSha, force: false }),
    },
  );
  if (!fetched.ok) {
    return fetched;
  }
  if (fetched.response.status === 409) {
    return { ok: false, response: conflictResponse() };
  }
  if (fetched.response.status === 404) {
    return createFirstBranchRef(base, token, owner, repoName, branch, commitSha);
  }
  const failure = mapGithubFailure(fetched.response);
  if (failure) {
    return { ok: false, response: failure };
  }
  return { ok: true, branch, commitSha };
}

/** 空リポジトリの初回コミット用にブランチ参照を新規作成する */
async function createFirstBranchRef(
  base: string,
  token: string,
  owner: string,
  repoName: string,
  branch: string,
  commitSha: string,
): Promise<CommitToGithubResult> {
  const fetched = await fetchApi(base, `/repos/${owner}/${repoName}/git/refs`, token, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha }),
  });
  if (!fetched.ok) {
    return fetched;
  }
  if (fetched.response.status === 409) {
    return { ok: false, response: conflictResponse() };
  }
  const failure = mapGithubFailure(fetched.response);
  if (failure) {
    return { ok: false, response: failure };
  }
  return { ok: true, branch, commitSha };
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
