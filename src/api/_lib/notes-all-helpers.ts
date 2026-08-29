import { githubApiFetch, githubUnreachable, mapGithubFailure } from '@/api/_lib/github-proxy';
import { readField, readJsonBody, readNonEmptyStringField } from '@/api/_lib/github-json';
import { listCachedNotes, readVaultMeta, writeCachedNote } from '@/api/_lib/r2-vault';

/** Blob 並列取得の同時実行上限 */
const BLOB_FETCH_CONCURRENCY = 8;

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type GithubEntry = {
  type?: unknown;
  path?: unknown;
  sha?: unknown;
};

/** R2 キャッシュがあればそこから返す（ヒットすれば Response） */
export async function tryServeFromR2(
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

type TreeResult =
  | { readonly ok: true; readonly body: unknown; readonly entries: GithubEntry[] }
  | { readonly ok: false; readonly response: Response };

export async function fetchTreeEntries(
  apiBaseUrl: string,
  token: string,
  owner: string,
  repoName: string,
  defaultBranch: string,
): Promise<TreeResult> {
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
      return { ok: true, body: { truncated: false }, entries: [] };
    }
    return { ok: false, response: treeFailure };
  }
  const treeResponseBody = await readJsonBody(treeResponse);
  const treeEntries: GithubEntry[] | null = ((): GithubEntry[] | null => {
    if (!isRecordObject(treeResponseBody) || !Array.isArray(treeResponseBody.tree)) {
      return null;
    }
    const entries: GithubEntry[] = [];
    for (const item of treeResponseBody.tree) {
      if (isRecordObject(item)) {
        entries.push({ type: item.type, path: item.path, sha: item.sha });
      }
    }
    return entries;
  })();
  if (treeEntries === null) {
    return { ok: false, response: Response.json({ error: 'github_error' }, { status: 502 }) };
  }
  return { ok: true, body: treeResponseBody, entries: treeEntries };
}

export function extractNoteBlobs(entries: readonly GithubEntry[]): { path: string; sha: string }[] {
  const noteBlobs: { path: string; sha: string }[] = [];
  for (const entry of entries) {
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
  return noteBlobs;
}

type NotesFetchResult = {
  readonly notes: { path: string; sha: string; content: string }[];
  readonly truncated: boolean;
};

export async function fetchNotesChunked(
  apiBaseUrl: string,
  token: string,
  owner: string,
  repoName: string,
  noteBlobs: readonly { path: string; sha: string }[],
  bucket: R2Bucket | undefined,
  treeBody: unknown,
): Promise<NotesFetchResult> {
  let shouldCache = false;
  if (bucket) {
    const meta = await readVaultMeta(bucket, owner, repoName);
    shouldCache = meta !== null;
  }
  const notes: { path: string; sha: string; content: string }[] = [];
  for (let offset = 0; offset < noteBlobs.length; offset += BLOB_FETCH_CONCURRENCY) {
    const chunk = noteBlobs.slice(offset, offset + BLOB_FETCH_CONCURRENCY);
    // oxlint-disable-next-line no-await-in-loop -- 同時実行数を 8 に制限する意図的なチャンク処理
    const chunkResults = await Promise.all(
      chunk.map(async ({ path, sha }) => {
        let response: Response;
        try {
          response = await githubApiFetch(
            apiBaseUrl,
            `/repos/${owner}/${repoName}/git/blobs/${encodeURIComponent(sha)}`,
            token,
          );
        } catch {
          return null;
        }
        if (!response.ok) {
          return null;
        }
        const rawBody: unknown = await response.json().catch(() => null);
        const base64Content: string | null = ((): string | null => {
          if (
            !isRecordObject(rawBody) ||
            rawBody.encoding !== 'base64' ||
            typeof rawBody.content !== 'string'
          ) {
            return null;
          }
          return rawBody.content;
        })();
        if (base64Content === null) {
          return null;
        }
        const bytes = Uint8Array.from(atob(base64Content), (char) => char.charCodeAt(0));
        const content = new TextDecoder().decode(bytes);
        return { path, sha, content };
      }),
    );
    for (const result of chunkResults) {
      if (result === null) {
        continue;
      }
      notes.push(result);
      if (shouldCache && bucket) {
        // oxlint-disable-next-line no-await-in-loop -- 取得済みノートの R2 書き込み（順次実行）のため
        await writeCachedNote(bucket, owner, repoName, result.path, {
          sha: result.sha,
          content: result.content,
        });
      }
    }
  }
  return { notes, truncated: readField(treeBody, 'truncated') === true };
}
