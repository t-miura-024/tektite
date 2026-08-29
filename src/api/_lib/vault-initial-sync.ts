import { githubApiFetch, githubUnreachable, mapGithubFailure } from '@/api/_lib/github-proxy';
import { readField, readJsonBody, readNonEmptyStringField } from '@/api/_lib/github-json';
import {
  listCachedNotePaths,
  writeCachedNote,
  writeVaultMeta,
  writeVaultTree,
} from '@/api/_lib/r2-vault';
import { fetchBlobContent } from '@/api/_lib/vault-sync-blob';
import { parseTreeBody, type GithubTreeResponse } from '@/api/_lib/vault-sync-tree';

/** Markdown blob 並列取得の同時実行上限（GitHub のレートリミット消費を抑える） */
const BLOB_FETCH_CONCURRENCY = 8;

/**
 * 1 リクエストで取得する blob 数の上限（同期のチャンク化。2026-08-16 の事故後）。
 *
 * Cloudflare Workers Free プランの外部 fetch サブリクエスト制限（50 件/リクエスト）
 * を超過しないための安全値。1 リクエストは「ツリー取得 + repo 取得 + blob 取得」を
 * 行うため、blob 側を 40 件に抑えても合計 42 件程度になる。大量のノートがある
 * Vault は 1 リクエストで全量を取得せず、レスポンスの `remaining` を見て
 * クライアントが複数リクエストに分割して取得する。
 */
const SYNC_FETCH_LIMIT = 40;

type InitialSyncContext = {
  readonly bucket: R2Bucket;
  readonly owner: string;
  readonly repoName: string;
  readonly apiBaseUrl: string;
  readonly token: string;
};

/**
 * 初期同期を実行する（R2 にメタが無い Vault の全量取り込み）。
 * 成功時は initialized / syncing のいずれかを返す。
 */
export async function performInitialSync(context: InitialSyncContext): Promise<Response> {
  let defaultBranch: string;
  {
    let repoResponse: Response;
    try {
      repoResponse = await githubApiFetch(
        context.apiBaseUrl,
        `/repos/${context.owner}/${context.repoName}`,
        context.token,
      );
    } catch {
      return githubUnreachable();
    }
    const repoFailure = mapGithubFailure(repoResponse);
    if (repoFailure) {
      return repoFailure;
    }
    const repoInfo = await readJsonBody(repoResponse);
    const branch = readNonEmptyStringField(repoInfo, 'default_branch');
    if (branch === null) {
      return Response.json({ error: 'github_error' }, { status: 502 });
    }
    const permissions = readField(repoInfo, 'permissions');
    const push =
      typeof permissions === 'object' && permissions !== null && 'push' in permissions
        ? permissions.push
        : undefined;
    if (push !== true) {
      return Response.json(
        { error: 'read_only_vault', message: 'この Vault には書き込み権限がありません。' },
        { status: 403 },
      );
    }
    defaultBranch = branch;
  }
  let treeBody: GithubTreeResponse;
  {
    let treeResponse: Response;
    try {
      treeResponse = await githubApiFetch(
        context.apiBaseUrl,
        `/repos/${context.owner}/${context.repoName}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
        context.token,
      );
    } catch {
      return githubUnreachable();
    }
    let body: GithubTreeResponse = { sha: null, truncated: false, tree: [] };
    if (treeResponse.status !== 404) {
      const failure = mapGithubFailure(treeResponse);
      if (failure) {
        return failure;
      }
      const parsed = parseTreeBody(await readJsonBody(treeResponse));
      if (parsed === null) {
        return Response.json({ error: 'github_error' }, { status: 502 });
      }
      body = parsed;
    }
    treeBody = body;
  }
  const treeEntries = treeBody.tree ?? [];
  const noteBlobs: { path: string; sha: string }[] = [];
  const entries: { path: string; type: 'file' | 'directory'; sha: string | null }[] = [];
  for (const entry of treeEntries) {
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      continue;
    }
    if (entry.type === 'blob') {
      const sha = typeof entry.sha === 'string' ? entry.sha : null;
      entries.push({
        path: entry.path,
        type: 'file',
        sha: sha !== null && sha.length > 0 ? sha : null,
      });
      if (entry.path.endsWith('.md') && sha !== null && sha.length > 0) {
        noteBlobs.push({ path: entry.path, sha });
      }
      continue;
    }
    if (entry.type === 'tree') {
      entries.push({ path: entry.path, type: 'directory', sha: null });
    }
  }
  let fetchResult: { readonly notes: number; readonly remaining: number } | Response;
  {
    const existingPaths = await listCachedNotePaths(
      context.bucket,
      context.owner,
      context.repoName,
    );
    const pendingBlobs = noteBlobs.filter(({ path }) => !existingPaths.has(path));
    const fetchTargets = pendingBlobs.slice(0, SYNC_FETCH_LIMIT);
    let notes = 0;
    let errorResponse: Response | null = null;
    for (let offset = 0; offset < fetchTargets.length; offset += BLOB_FETCH_CONCURRENCY) {
      const chunk = fetchTargets.slice(offset, offset + BLOB_FETCH_CONCURRENCY);
      // oxlint-disable-next-line no-await-in-loop -- 同時実行数を 8 に制限する意図的なチャンク処理
      const chunkResults = await Promise.all(
        chunk.map(async ({ path, sha }) => {
          const content = await fetchBlobContent(
            context.apiBaseUrl,
            context.token,
            context.owner,
            context.repoName,
            sha,
          );
          return content === null ? null : { path, sha, content };
        }),
      );
      for (const result of chunkResults) {
        if (result === null) {
          errorResponse = Response.json(
            {
              error: 'github_error',
              message: 'ノートの取得に失敗しました。しばらくしてからもう一度お試しください。',
            },
            { status: 502 },
          );
          break;
        }
        // oxlint-disable-next-line no-await-in-loop -- 取得済みノートの R2 書き込み（チャンク内で順次実行）のため
        await writeCachedNote(context.bucket, context.owner, context.repoName, result.path, {
          sha: result.sha,
          content: result.content,
        });
        notes += 1;
      }
      if (errorResponse !== null) {
        break;
      }
    }
    fetchResult =
      errorResponse !== null
        ? errorResponse
        : { notes, remaining: pendingBlobs.length - fetchTargets.length };
  }
  if (fetchResult instanceof Response) {
    return fetchResult;
  }
  if (fetchResult.remaining > 0) {
    return Response.json(
      {
        owner: context.owner,
        name: context.repoName,
        status: 'syncing',
        defaultBranch,
        remaining: fetchResult.remaining,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  {
    const treeSha =
      typeof treeBody.sha === 'string' && treeBody.sha.length > 0 ? treeBody.sha : null;
    await writeVaultTree(context.bucket, context.owner, context.repoName, {
      defaultBranch,
      truncated: treeBody.truncated === true,
      treeSha,
      entries: [...entries],
    });
    await writeVaultMeta(context.bucket, context.owner, context.repoName, {
      syncedAt: new Date().toISOString(),
      defaultBranch,
      treeSha,
    });
  }
  return Response.json(
    {
      owner: context.owner,
      name: context.repoName,
      status: 'initialized',
      defaultBranch,
      notes: fetchResult.notes,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
