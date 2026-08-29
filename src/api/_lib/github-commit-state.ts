/**
 * 一括コミット前の GitHub 状態読み取り。
 *
 * デフォルトブランチの解決（リポジトリ情報）、ブランチ先頭コミット sha、
 * base tree（パス → blob sha 対応）を取得する。コミット 0 件の空リポジトリは
 * ref / trees が 404 を返すため、「先頭コミット無し・base_tree 無し」として
 * 扱う（github-commit.ts の初回コミットフローの前提）。
 */

import { githubApiFetch, githubUnreachable, mapGithubFailure } from '@/api/_lib/github-proxy';
import {
  readField,
  readJsonBody,
  readNonEmptyStringField,
  readStringField,
} from '@/api/_lib/github-json';

/** ブランチ先頭のコミット sha（空リポジトリは null）と base tree 情報 */
export type BranchState = {
  readonly headCommitSha: string | null;
  /** 空リポジトリ（コミット 0 件）では null */
  readonly baseTreeSha: string | null;
  readonly blobShaByPath: Map<string, string>;
};

/** fetch 結果（ネットワーク失敗時は完成済みの 502 応答） */
export type GithubFetchResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly response: Response };

const githubErrorResponse: Response = Response.json({ error: 'github_error' }, { status: 502 });

/** ステップ 1: リポジトリ情報からデフォルトブランチを解決する */
export async function resolveDefaultBranch(
  base: string,
  token: string,
  owner: string,
  repoName: string,
): Promise<{ ok: true; branch: string } | { ok: false; response: Response }> {
  const fetched = await fetchApi(base, `/repos/${owner}/${repoName}`, token);
  if (!fetched.ok) {
    return fetched;
  }
  const failure = mapGithubFailure(fetched.response);
  if (failure) {
    return { ok: false, response: failure };
  }
  const body: unknown = await readJsonBody(fetched.response);
  const branch = readNonEmptyStringField(body, 'default_branch');
  if (branch === null) {
    return { ok: false, response: githubErrorResponse };
  }
  return { ok: true, branch };
}

/** ステップ 2 + 3: 先頭コミット sha と base tree（パス → blob sha 対応）を読む */
export async function readBranchState(
  base: string,
  token: string,
  owner: string,
  repoName: string,
  branch: string,
): Promise<{ ok: true; state: BranchState } | { ok: false; response: Response }> {
  // ref の 404 はコミット 0 件の空リポジトリ（初回コミット。parents 無しで作る）
  const refFetched = await fetchApi(
    base,
    `/repos/${owner}/${repoName}/git/ref/heads/${encodeURIComponent(branch)}`,
    token,
  );
  if (!refFetched.ok) {
    return refFetched;
  }
  let headCommitSha: string | null = null;
  if (refFetched.response.status !== 404) {
    const refFailure = mapGithubFailure(refFetched.response);
    if (refFailure) {
      return { ok: false, response: refFailure };
    }
    const object = readField(await readJsonBody(refFetched.response), 'object');
    headCommitSha = readNonEmptyStringField(object, 'sha');
    if (headCommitSha === null) {
      return { ok: false, response: githubErrorResponse };
    }
  }
  const treeFetched = await fetchApi(
    base,
    `/repos/${owner}/${repoName}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    token,
  );
  if (!treeFetched.ok) {
    return treeFetched;
  }
  if (treeFetched.response.status === 404) {
    return {
      ok: true,
      state: { headCommitSha, baseTreeSha: null, blobShaByPath: new Map() },
    };
  }
  const failure = mapGithubFailure(treeFetched.response);
  if (failure) {
    return { ok: false, response: failure };
  }
  const body: unknown = await readJsonBody(treeFetched.response);
  const baseTreeSha = readNonEmptyStringField(body, 'sha');
  const entries = readField(body, 'tree');
  if (baseTreeSha === null || !Array.isArray(entries)) {
    return { ok: false, response: githubErrorResponse };
  }
  const blobShaByPath = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const entryPath = readNonEmptyStringField(entry, 'path');
    const entrySha = readNonEmptyStringField(entry, 'sha');
    if (readStringField(entry, 'type') === 'blob' && entryPath !== null && entrySha !== null) {
      blobShaByPath.set(entryPath, entrySha);
    }
  }
  return {
    ok: true,
    state: { headCommitSha, baseTreeSha, blobShaByPath },
  };
}

/** fetch の失敗を github_unreachable（502）に変換して fetch する */
async function fetchApi(
  base: string,
  path: string,
  token: string,
  init?: { method?: string; body?: string },
): Promise<GithubFetchResult> {
  try {
    return { ok: true, response: await githubApiFetch(base, path, token, init) };
  } catch {
    return { ok: false, response: githubUnreachable() };
  }
}
