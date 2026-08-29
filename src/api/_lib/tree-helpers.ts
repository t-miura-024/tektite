import { githubApiFetch, githubUnreachable, mapGithubFailure } from '@/api/_lib/github-proxy';
import { readField, readJsonBody, readNonEmptyStringField } from '@/api/_lib/github-json';
import { readVaultMeta, readVaultTree, writeVaultTree } from '@/api/_lib/r2-vault';

/** ツリーエントリ 1 件を file / directory のエントリへ変換する（対象外は null） */
export function collectTreeEntry(
  item: unknown,
): { path: string; type: 'file' | 'directory'; sha: string | null } | null {
  if (typeof item !== 'object' || item === null) {
    return null;
  }
  if (!('path' in item) || typeof item.path !== 'string' || item.path.length === 0) {
    return null;
  }
  const path = item.path;
  if ('type' in item && item.type === 'blob') {
    const sha = 'sha' in item ? item.sha : undefined;
    return {
      path,
      type: 'file',
      sha: typeof sha === 'string' && sha.length > 0 ? sha : null,
    };
  }
  if ('type' in item && item.type === 'tree') {
    return { path, type: 'directory', sha: null };
  }
  return null;
}

/** R2 キャッシュがあればそこから返す（ヒットすれば Response） */
export async function tryServeTreeFromR2(
  bucket: R2Bucket | undefined,
  owner: string,
  repoName: string,
): Promise<Response | null> {
  if (!bucket) {
    return null;
  }
  const meta = await readVaultMeta(bucket, owner, repoName);
  if (meta === null) {
    return null;
  }
  const cached = await readVaultTree(bucket, owner, repoName);
  if (cached === null) {
    return null;
  }
  return Response.json(
    {
      owner,
      name: repoName,
      defaultBranch: cached.defaultBranch,
      truncated: cached.truncated,
      entries: cached.entries.map(({ path, type }) => ({ path, type })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

type DefaultBranchResult =
  | { readonly ok: true; readonly branch: string }
  | { readonly ok: false; readonly response: Response };

export async function fetchDefaultBranch(
  apiBaseUrl: string,
  token: string,
  owner: string,
  repoName: string,
): Promise<DefaultBranchResult> {
  let repoResponse: Response;
  try {
    repoResponse = await githubApiFetch(apiBaseUrl, `/repos/${owner}/${repoName}`, token);
  } catch {
    return { ok: false, response: githubUnreachable() };
  }
  const repoFailure = mapGithubFailure(repoResponse);
  if (repoFailure) {
    return { ok: false, response: repoFailure };
  }
  const defaultBranch = readNonEmptyStringField(await readJsonBody(repoResponse), 'default_branch');
  if (defaultBranch === null) {
    return { ok: false, response: Response.json({ error: 'github_error' }, { status: 502 }) };
  }
  return { ok: true, branch: defaultBranch };
}

type TreeFetchResult =
  | {
      readonly ok: true;
      readonly defaultBranch: string;
      readonly truncated: boolean;
      readonly entries: { path: string; type: 'file' | 'directory'; sha: string | null }[];
      readonly body: unknown;
    }
  | { readonly ok: false; readonly response: Response };

export async function fetchTree(
  apiBaseUrl: string,
  token: string,
  owner: string,
  repoName: string,
  defaultBranch: string,
): Promise<TreeFetchResult> {
  let treeResponse: Response;
  try {
    treeResponse = await githubApiFetch(
      apiBaseUrl,
      `/repos/${owner}/${repoName}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
      token,
    );
  } catch {
    return { ok: false, response: githubUnreachable() };
  }
  const treeFailure = mapGithubFailure(treeResponse);
  if (treeFailure) {
    if (treeResponse.status === 404) {
      return {
        ok: true,
        defaultBranch,
        truncated: false,
        entries: [],
        body: { truncated: false },
      };
    }
    return { ok: false, response: treeFailure };
  }
  const treeBody = await readJsonBody(treeResponse);
  const rawEntries = readField(treeBody, 'tree');
  if (!Array.isArray(rawEntries)) {
    return { ok: false, response: Response.json({ error: 'github_error' }, { status: 502 }) };
  }
  const truncated = readField(treeBody, 'truncated') === true;
  const entries: { path: string; type: 'file' | 'directory'; sha: string | null }[] = [];
  for (const item of rawEntries) {
    const entry = collectTreeEntry(item);
    if (entry !== null) {
      entries.push(entry);
    }
  }
  return { ok: true, defaultBranch, truncated, entries, body: treeBody };
}

export async function cacheTreeIfNeeded(
  bucket: R2Bucket | undefined,
  owner: string,
  repoName: string,
  defaultBranch: string,
  truncated: boolean,
  entries: { path: string; type: 'file' | 'directory'; sha: string | null }[],
  body: unknown,
): Promise<void> {
  if (!bucket) {
    return;
  }
  const meta = await readVaultMeta(bucket, owner, repoName);
  if (meta === null) {
    return;
  }
  const treeSha = readNonEmptyStringField(body, 'sha');
  await writeVaultTree(bucket, owner, repoName, {
    defaultBranch,
    truncated,
    treeSha,
    entries,
  });
}
