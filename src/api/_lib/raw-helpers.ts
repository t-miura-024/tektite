import { githubApiFetch, githubUnreachable, mapGithubFailure } from '@/api/_lib/github-proxy';
import { readVaultMeta, readVaultTree } from '@/api/_lib/r2-vault';
import { readCachedRaw, writeCachedRaw } from '@/api/_lib/r2-vault-assets';

/** R2 キャッシュから raw 応答を試す（ヒットすれば Response、ミスなら null） */
export async function tryServeRawFromR2(
  bucket: R2Bucket | undefined,
  owner: string,
  repoName: string,
  rawPath: string,
): Promise<Response | null> {
  if (!bucket) {
    return null;
  }
  const meta = await readVaultMeta(bucket, owner, repoName);
  if (meta === null) {
    return null;
  }
  const cached = await readCachedRaw(bucket, owner, repoName, rawPath);
  if (cached !== null) {
    return new Response(cached.body, {
      headers: {
        'Content-Type': cached.contentType,
        'Cache-Control': 'public, max-age=300',
      },
    });
  }
  const tree = await readVaultTree(bucket, owner, repoName);
  if (tree !== null && !tree.entries.some((entry) => entry.path === rawPath)) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return null;
}

/** GitHub から raw を取得し、必要なら R2 へキャッシュして Response を返す */
export async function fetchRawFromGithub(
  bucket: R2Bucket | undefined,
  owner: string,
  repoName: string,
  rawPath: string,
  apiBaseUrl: string,
  token: string,
  encodeRawPath: (path: string) => string,
): Promise<Response> {
  let response: Response;
  try {
    response = await githubApiFetch(
      apiBaseUrl,
      `/repos/${owner}/${repoName}/contents/${encodeRawPath(rawPath)}`,
      token,
      { headers: { Accept: 'application/vnd.github.raw' } },
    );
  } catch {
    return githubUnreachable();
  }
  const failure = mapGithubFailure(response);
  if (failure) {
    return failure;
  }
  const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream';
  if (bucket) {
    const meta = await readVaultMeta(bucket, owner, repoName);
    if (meta !== null) {
      const body = await response
        .clone()
        .arrayBuffer()
        .catch(() => null);
      if (body !== null) {
        await writeCachedRaw(bucket, owner, repoName, rawPath, body, contentType);
      }
    }
  }
  return new Response(response.body, {
    headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=300' },
  });
}
