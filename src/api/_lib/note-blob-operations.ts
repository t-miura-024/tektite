import { githubApiFetch, githubUnreachable, mapGithubFailure } from '@/api/_lib/github-proxy';
import { sha256Hex } from '@/api/_lib/content-hash';
import { readCachedNote, readVaultMeta, readVaultTree, writeCachedNote } from '@/api/_lib/r2-vault';
import { applyVaultTreeChanges } from '@/api/_lib/r2-vault-tree-apply';
import { readCachedRaw } from '@/api/_lib/r2-vault-assets';
import { markVaultDirty } from '@/api/_lib/r2-vault-marks';
import { decodeBase64Content, encodeNotePath } from '@/api/_lib/note-blob-helpers';

/** R2 キャッシュから GET 応答を試す（ヒットすれば Response、ミスなら null） */
export async function tryServeFromR2(
  bucket: R2Bucket,
  owner: string,
  repoName: string,
  notePath: string,
): Promise<Response | null> {
  const meta = await readVaultMeta(bucket, owner, repoName);
  if (meta === null) {
    return null;
  }
  const cached = await readCachedNote(bucket, owner, repoName, notePath);
  if (cached !== null) {
    return Response.json(
      {
        owner,
        name: repoName,
        path: notePath,
        sha: cached.sha,
        content: cached.content,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const raw = await readCachedRaw(bucket, owner, repoName, notePath);
  if (raw !== null) {
    const content = new TextDecoder().decode(raw.body);
    return Response.json(
      {
        owner,
        name: repoName,
        path: notePath,
        sha: await sha256Hex(content),
        content,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const tree = await readVaultTree(bucket, owner, repoName);
  if (tree !== null && !tree.entries.some((entry) => entry.path === notePath)) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return null;
}

/** GitHub からノートを取得し、必要なら R2 へキャッシュして Response を返す */
export async function fetchNoteFromGithub(
  bucket: R2Bucket | undefined,
  owner: string,
  repoName: string,
  notePath: string,
  apiBaseUrl: string,
  token: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await githubApiFetch(
      apiBaseUrl,
      `/repos/${owner}/${repoName}/contents/${encodeNotePath(notePath)}`,
      token,
    );
  } catch {
    return githubUnreachable();
  }
  const failure = mapGithubFailure(response);
  if (failure) {
    return failure;
  }
  const body = await response.json().catch(() => null);
  if (
    typeof body !== 'object' ||
    body === null ||
    !('type' in body) ||
    !('encoding' in body) ||
    !('content' in body) ||
    !('sha' in body) ||
    body.type !== 'file' ||
    body.encoding !== 'base64' ||
    typeof body.content !== 'string' ||
    typeof body.sha !== 'string' ||
    body.sha.length === 0
  ) {
    return Response.json({ error: 'github_error' }, { status: 502 });
  }
  if (bucket) {
    const meta = await readVaultMeta(bucket, owner, repoName);
    if (meta !== null) {
      await writeCachedNote(bucket, owner, repoName, notePath, {
        sha: body.sha,
        content: decodeBase64Content(body.content),
      });
    }
  }
  return Response.json(
    {
      owner,
      name: repoName,
      path: notePath,
      sha: body.sha,
      content: decodeBase64Content(body.content),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/** R2 先行で PUT を処理する（R2 メタありの場合のみ。処理したら Response、未同期なら null） */
export async function handleR2Put(
  bucket: R2Bucket,
  owner: string,
  repoName: string,
  notePath: string,
  body: { content: string; sha: string | null },
): Promise<Response | null> {
  const meta = await readVaultMeta(bucket, owner, repoName);
  if (meta === null) {
    return null;
  }
  if (body.sha !== null) {
    const cached = await readCachedNote(bucket, owner, repoName, notePath);
    if (cached === null || cached.sha !== body.sha) {
      return Response.json(
        { error: 'conflict', message: 'リモートの内容が変更されています。' },
        { status: 409 },
      );
    }
  }
  const content = decodeBase64Content(body.content);
  const savedSha = await sha256Hex(content);
  await writeCachedNote(bucket, owner, repoName, notePath, { sha: savedSha, content });
  await markVaultDirty(bucket, owner, repoName, notePath);
  if (body.sha === null) {
    await applyVaultTreeChanges(bucket, owner, repoName, [{ op: 'add', path: notePath }]);
  }
  return Response.json(
    { owner, name: repoName, path: notePath, sha: savedSha },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/** GitHub Contents API へ PUT し、必要なら R2 へ反映して Response を返す */
export async function putNoteToGithub(
  bucket: R2Bucket | undefined,
  owner: string,
  repoName: string,
  notePath: string,
  body: { content: string; message: string; sha: string | null },
  apiBaseUrl: string,
  token: string,
): Promise<Response> {
  const githubBody: { content: string; message: string; sha?: string } = {
    content: body.content,
    message: body.message,
  };
  if (body.sha !== null) {
    githubBody.sha = body.sha;
  }
  let response: Response;
  try {
    response = await githubApiFetch(
      apiBaseUrl,
      `/repos/${owner}/${repoName}/contents/${encodeNotePath(notePath)}`,
      token,
      { method: 'PUT', body: JSON.stringify(githubBody) },
    );
  } catch {
    return githubUnreachable();
  }
  if (response.status === 409) {
    const conflictBody = await response.json().catch(() => null);
    const message =
      typeof conflictBody === 'object' &&
      conflictBody !== null &&
      'message' in conflictBody &&
      typeof conflictBody.message === 'string'
        ? conflictBody.message
        : 'リモートの内容が変更されています。';
    return Response.json({ error: 'conflict', message }, { status: 409 });
  }
  const failure = mapGithubFailure(response);
  if (failure) {
    return failure;
  }
  const savedBody: unknown = await response.json().catch(() => null);
  const savedContent =
    typeof savedBody === 'object' && savedBody !== null && 'content' in savedBody
      ? savedBody.content
      : undefined;
  const savedSha =
    typeof savedContent === 'object' && savedContent !== null && 'sha' in savedContent
      ? savedContent.sha
      : undefined;
  if (typeof savedSha !== 'string' || savedSha.length === 0) {
    return Response.json({ error: 'github_error' }, { status: 502 });
  }
  if (bucket) {
    const meta = await readVaultMeta(bucket, owner, repoName);
    if (meta !== null) {
      await writeCachedNote(bucket, owner, repoName, notePath, {
        sha: savedSha,
        content: decodeBase64Content(body.content),
      });
    }
  }
  return Response.json(
    { owner, name: repoName, path: notePath, sha: savedSha },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
