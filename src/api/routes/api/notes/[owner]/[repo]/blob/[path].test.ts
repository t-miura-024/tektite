/**
 * ノート取得/保存エンドポイント（GET|PUT /api/notes/:owner/:repo/blob/:path）の
 * ユニットテスト。
 *
 * 実ネットワークを使わず、GitHub プロキシ基盤（github-proxy）の githubApiFetch /
 * mapGithubFailure をモックして、ボディ検証と 409（sha 楽観ロック競合）→
 * conflict 変換、正常系の応答整形を検証する。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveProxyConfig: vi.fn(),
  authenticateRequest: vi.fn(),
  githubApiFetch: vi.fn(),
  githubUnreachable: vi.fn(),
  mapGithubFailure: vi.fn(),
}));

vi.mock('@/api/_lib/github-proxy', () => ({
  ProxyConfigError: class ProxyConfigError extends Error {
    name = 'ProxyConfigError';
  },
  resolveProxyConfig: mocks.resolveProxyConfig,
  authenticateRequest: mocks.authenticateRequest,
  githubApiFetch: mocks.githubApiFetch,
  githubUnreachable: mocks.githubUnreachable,
  mapGithubFailure: mocks.mapGithubFailure,
}));

// eslint-disable-next-line import/first -- vi.mock は import より前に置く必要がある
import { handleNoteBlobGet, handleNoteBlobPut } from './[path]';
import { createFakeR2Bucket } from '@/api/_lib/fake-r2';
import { sha256Hex } from '@/api/_lib/content-hash';
import {
  readCachedNote,
  readVaultTree,
  writeCachedNote,
  writeCachedRaw,
  writeVaultMeta,
  writeVaultTree,
} from '@/api/_lib/r2-vault';

const ENV = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  GITHUB_API_BASE_URL: 'http://mock.invalid',
} as unknown as Env;

const PARAMS = { owner: 'octocat', repo: 'notes', path: 'daily%2F2026-08-08.md' };

/** ASCII 本文を base64 にエンコードする（テストデータは ASCII のみ） */
function toBase64(text: string): string {
  return btoa(text);
}

/** bucket 付きの Env を作る（省略時は R2 なし） */
function envWithBucket(bucket?: R2Bucket): Env {
  return {
    ...ENV,
    ...(bucket === undefined ? {} : { VAULT_BUCKET: bucket }),
  } as unknown as Env;
}

/** PUT ハンドラの実行コンテキスト（部分オブジェクトを Pages 型に合わせる） */
function putContext(
  request: Request,
  params: Record<string, string | string[]> = PARAMS,
  bucket?: R2Bucket,
): Parameters<typeof handleNoteBlobPut>[0] {
  return {
    env: envWithBucket(bucket),
    request,
    params,
  } as unknown as Parameters<typeof handleNoteBlobPut>[0];
}

function getContext(
  request: Request,
  params: Record<string, string | string[]> = PARAMS,
  bucket?: R2Bucket,
): Parameters<typeof handleNoteBlobGet>[0] {
  return {
    env: envWithBucket(bucket),
    request,
    params,
  } as unknown as Parameters<typeof handleNoteBlobGet>[0];
}

/** base64 エンコード済みの PUT ボディを持つリクエストを作る */
function putRequest(body: unknown): Request {
  return new Request('http://localhost/api/notes/octocat/notes/blob/daily%2F2026-08-08.md', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

function okAuth() {
  mocks.authenticateRequest.mockResolvedValue({ ok: true, token: 'token' });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveProxyConfig.mockReturnValue({
    sessionSecret: ENV.SESSION_SECRET,
    apiBaseUrl: ENV.GITHUB_API_BASE_URL,
  });
  okAuth();
});

describe('PUT /api/notes/:owner/:repo/blob/:path', () => {
  it('有効なボディで Contents API に PUT を転送し、保存後の sha を返す', async () => {
    mocks.githubApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ content: { sha: 'sha-after-save' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await handleNoteBlobPut(
      putContext(
        putRequest({
          content: toBase64('# saved\n'),
          sha: 'sha-read',
          message: 'Update 2026-08-08.md',
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      path: 'daily/2026-08-08.md',
      sha: 'sha-after-save',
    });
    expect(mocks.githubApiFetch).toHaveBeenCalledWith(
      'http://mock.invalid',
      '/repos/octocat/notes/contents/daily/2026-08-08.md',
      'token',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('sha なしのボディ（新規作成）では sha を転送しない', async () => {
    mocks.githubApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ content: { sha: 'sha-new' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await handleNoteBlobPut(
      putContext(
        putRequest({
          content: toBase64('# new\n'),
          message: 'Create new-note.md',
        }),
        { ...PARAMS, path: 'new-note.md' },
      ),
    );

    expect(response.status).toBe(200);
    const sentBody = JSON.parse(String(mocks.githubApiFetch.mock.calls[0]?.[3]?.body));
    expect(sentBody).toEqual({ content: expect.any(String), message: 'Create new-note.md' });
    expect(sentBody.sha).toBeUndefined();
  });

  it('空の content（空ファイル保存）も 400 にせず Contents API に転送する', async () => {
    mocks.githubApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ content: { sha: 'sha-empty' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await handleNoteBlobPut(
      putContext(
        putRequest({
          content: '',
          sha: 'sha-read',
          message: 'Update 2026-08-08.md',
        }),
      ),
    );

    expect(response.status).toBe(200);
    const sentBody = JSON.parse(String(mocks.githubApiFetch.mock.calls[0]?.[3]?.body));
    expect(sentBody).toEqual({
      content: '',
      message: 'Update 2026-08-08.md',
      sha: 'sha-read',
    });
  });

  it('GitHub の 409 は error: conflict の 409 としてそのまま伝える', async () => {
    mocks.githubApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ message: 'sha does not match current blob sha' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await handleNoteBlobPut(
      putContext(
        putRequest({
          content: toBase64('# saved\n'),
          sha: 'sha-stale',
          message: 'Update 2026-08-08.md',
        }),
      ),
    );

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      error: 'conflict',
      message: 'sha does not match current blob sha',
    });
    // 409 は mapGithubFailure（502 化）を通さずに処理する
    expect(mocks.mapGithubFailure).not.toHaveBeenCalled();
  });

  it('不正なボディ（base64 でない content）は 400 invalid_note_body', async () => {
    const response = await handleNoteBlobPut(
      putContext(putRequest({ content: 'not base64!', sha: 'sha', message: 'Update' })),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: 'invalid_note_body' });
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('ボディ欠落（content / message なし）は 400 invalid_note_body', async () => {
    const missingContent = await handleNoteBlobPut(
      putContext(putRequest({ sha: 'sha', message: 'Update' })),
    );
    expect(missingContent.status).toBe(400);

    const missingMessage = await handleNoteBlobPut(
      putContext(putRequest({ content: toBase64('# x\n') })),
    );
    expect(missingMessage.status).toBe(400);
  });

  it('未認証は 401 を返し、GitHub API を呼ばない', async () => {
    mocks.authenticateRequest.mockResolvedValue({
      ok: false,
      response: Response.json({ error: 'unauthenticated' }, { status: 401 }),
    });

    const response = await handleNoteBlobPut(
      putContext(putRequest({ content: toBase64('# saved\n'), message: 'Update 2026-08-08.md' })),
    );

    expect(response.status).toBe(401);
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });
});

describe('パラメータ検証（GET / PUT 共通）', () => {
  it('不正な owner / repo は 400 invalid_vault_ref', async () => {
    const response = await handleNoteBlobPut(
      putContext(putRequest({ content: toBase64('# x\n'), message: 'm' }), {
        ...PARAMS,
        owner: 'bad owner!',
      }),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: 'invalid_vault_ref' });
  });

  it('空のパスは 400 invalid_note_path', async () => {
    const response = await handleNoteBlobPut(
      putContext(putRequest({ content: toBase64('# x\n'), message: 'm' }), {
        ...PARAMS,
        path: '',
      }),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: 'invalid_note_path' });
  });

  it('パスセグメントのパーセントエンコードは GET 応答の path で復元される', async () => {
    mocks.githubApiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'file',
          encoding: 'base64',
          content: toBase64('# daily\n'),
          sha: 'sha-daily',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await handleNoteBlobGet(
      getContext(
        new Request('http://localhost/api/notes/octocat/notes/blob/daily%2F2026-08-08.md'),
      ),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(
      expect.objectContaining({ path: 'daily/2026-08-08.md', content: '# daily\n' }),
    );
  });

  it('空ファイル（content: ""）は空本文のノートとして返す', async () => {
    mocks.githubApiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ type: 'file', encoding: 'base64', content: '', sha: 'sha-empty' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await handleNoteBlobGet(
      getContext(new Request('http://localhost/api/notes/octocat/notes/blob/empty.md'), {
        ...PARAMS,
        path: 'empty.md',
      }),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(
      expect.objectContaining({ path: 'empty.md', content: '', sha: 'sha-empty' }),
    );
  });
});

describe('GET /api/notes/:owner/:repo/blob/:path（R2 キャッシュ: M3）', () => {
  it('初期同期済み Vault は R2 のノートを返す（GitHub API を消費しない）', async () => {
    const bucket = createFakeR2Bucket();
    await writeVaultMeta(bucket, 'octocat', 'notes', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-1',
    });
    await writeCachedNote(bucket, 'octocat', 'notes', 'daily/2026-08-08.md', {
      sha: 'sha-cached',
      content: '# cached\n',
    });

    const response = await handleNoteBlobGet(
      getContext(
        new Request('http://localhost/api/notes/octocat/notes/blob/daily%2F2026-08-08.md'),
        PARAMS,
        bucket,
      ),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      path: 'daily/2026-08-08.md',
      sha: 'sha-cached',
      content: '# cached\n',
    });
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('R2 に無い Note は GitHub から取得して書き戻す（遅延キャッシュ）', async () => {
    const bucket = createFakeR2Bucket();
    await writeVaultMeta(bucket, 'octocat', 'notes', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-1',
    });
    mocks.githubApiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'file',
          encoding: 'base64',
          content: toBase64('# fetched\n'),
          sha: 'sha-fetched',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await handleNoteBlobGet(
      getContext(
        new Request('http://localhost/api/notes/octocat/notes/blob/daily%2F2026-08-08.md'),
        PARAMS,
        bucket,
      ),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(
      expect.objectContaining({ sha: 'sha-fetched', content: '# fetched\n' }),
    );
    // 書き戻されている（次の読み取りは R2 から）
    expect(await readCachedNote(bucket, 'octocat', 'notes', 'daily/2026-08-08.md')).toEqual({
      sha: 'sha-fetched',
      content: '# fetched\n',
    });
  });

  it('メタなし（未同期）Vault は R2 を読まず GitHub 直行で、書き戻さない', async () => {
    const bucket = createFakeR2Bucket();
    mocks.githubApiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'file',
          encoding: 'base64',
          content: toBase64('# direct\n'),
          sha: 'sha-direct',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await handleNoteBlobGet(
      getContext(
        new Request('http://localhost/api/notes/octocat/notes/blob/daily%2F2026-08-08.md'),
        PARAMS,
        bucket,
      ),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(
      expect.objectContaining({ sha: 'sha-direct', content: '# direct\n' }),
    );
    expect(await readCachedNote(bucket, 'octocat', 'notes', 'daily/2026-08-08.md')).toBeNull();
  });

  it('添付（raw/ にある非 Markdown ファイル）もテキストとして返す（API 互換）', async () => {
    const bucket = createFakeR2Bucket();
    await writeVaultMeta(bucket, 'octocat', 'notes', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-1',
    });
    await writeCachedRaw(
      bucket,
      'octocat',
      'notes',
      'e2e-folder/.gitkeep',
      new TextEncoder().encode('').buffer,
      'application/octet-stream',
    );

    const response = await handleNoteBlobGet(
      getContext(
        new Request('http://localhost/api/notes/octocat/notes/blob/e2e-folder%2F.gitkeep'),
        { ...PARAMS, path: 'e2e-folder%2F.gitkeep' },
        bucket,
      ),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(
      expect.objectContaining({ path: 'e2e-folder/.gitkeep', content: '' }),
    );
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('ツリーに無いパスは 404 を返し、GitHub から復活させない（M4: 削除済みノート）', async () => {
    const bucket = createFakeR2Bucket();
    await writeVaultMeta(bucket, 'octocat', 'notes', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-1',
    });
    await writeVaultTree(bucket, 'octocat', 'notes', {
      defaultBranch: 'main',
      truncated: false,
      treeSha: 'tree-1',
      entries: [{ path: 'kept.md', type: 'file' }],
    });
    mocks.githubApiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'file',
          encoding: 'base64',
          content: toBase64('# resurrected\n'),
          sha: 'sha-github',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await handleNoteBlobGet(
      getContext(
        new Request('http://localhost/api/notes/octocat/notes/blob/daily%2F2026-08-08.md'),
        PARAMS,
        bucket,
      ),
    );

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: 'not_found' });
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });
});

describe('PUT /api/notes/:owner/:repo/blob/:path（R2 先行: M4）', () => {
  it('同期済み Vault は R2 へだけ反映する（GitHub API を消費しない）', async () => {
    const bucket = createFakeR2Bucket();
    await writeVaultMeta(bucket, 'octocat', 'notes', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-1',
    });
    await writeCachedNote(bucket, 'octocat', 'notes', 'daily/2026-08-08.md', {
      sha: 'sha-read',
      content: '# 旧内容\n',
    });

    const response = await handleNoteBlobPut(
      putContext(
        putRequest({
          content: toBase64('# saved\n'),
          sha: 'sha-read',
          message: 'Update 2026-08-08.md',
        }),
        PARAMS,
        bucket,
      ),
    );

    expect(response.status).toBe(200);
    // sha はコンテンツハッシュ（SHA-256）になる
    const savedSha = await sha256Hex('# saved\n');
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      path: 'daily/2026-08-08.md',
      sha: savedSha,
    });
    expect(await readCachedNote(bucket, 'octocat', 'notes', 'daily/2026-08-08.md')).toEqual({
      sha: savedSha,
      content: '# saved\n',
    });
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('読込時 sha と R2 の現在値が一致しない場合は 409 conflict で中断する', async () => {
    const bucket = createFakeR2Bucket();
    await writeVaultMeta(bucket, 'octocat', 'notes', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-1',
    });
    await writeCachedNote(bucket, 'octocat', 'notes', 'daily/2026-08-08.md', {
      sha: 'sha-current',
      content: '# 別クライアントが更新\n',
    });

    const response = await handleNoteBlobPut(
      putContext(
        putRequest({
          content: toBase64('# saved\n'),
          sha: 'sha-stale',
          message: 'Update 2026-08-08.md',
        }),
        PARAMS,
        bucket,
      ),
    );

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      error: 'conflict',
      message: 'リモートの内容が変更されています。',
    });
    // 競合時は R2 も GitHub も変更しない
    expect(await readCachedNote(bucket, 'octocat', 'notes', 'daily/2026-08-08.md')).toEqual({
      sha: 'sha-current',
      content: '# 別クライアントが更新\n',
    });
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('R2 にノートが無いのに sha が渡された場合も 409 conflict として扱う', async () => {
    const bucket = createFakeR2Bucket();
    await writeVaultMeta(bucket, 'octocat', 'notes', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-1',
    });

    const response = await handleNoteBlobPut(
      putContext(
        putRequest({
          content: toBase64('# saved\n'),
          sha: 'sha-unknown',
          message: 'Update 2026-08-08.md',
        }),
        PARAMS,
        bucket,
      ),
    );

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      error: 'conflict',
      message: 'リモートの内容が変更されています。',
    });
  });

  it('sha なしの新規作成は R2 へ書き、ツリーにも反映する', async () => {
    const bucket = createFakeR2Bucket();
    await writeVaultMeta(bucket, 'octocat', 'notes', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-1',
    });
    await writeVaultTree(bucket, 'octocat', 'notes', {
      defaultBranch: 'main',
      truncated: false,
      treeSha: 'tree-1',
      entries: [{ path: 'a.md', type: 'file' }],
    });

    const response = await handleNoteBlobPut(
      putContext(
        putRequest({
          content: toBase64('# new\n'),
          message: 'Create new-note.md',
        }),
        { ...PARAMS, path: 'new-note.md' },
        bucket,
      ),
    );

    expect(response.status).toBe(200);
    const savedSha = await sha256Hex('# new\n');
    expect(await readCachedNote(bucket, 'octocat', 'notes', 'new-note.md')).toEqual({
      sha: savedSha,
      content: '# new\n',
    });
    // ツリーにファイルエントリが追加されている（保存後の一覧表示と整合）
    expect(await readVaultTree(bucket, 'octocat', 'notes')).toEqual({
      defaultBranch: 'main',
      truncated: false,
      treeSha: 'tree-1',
      entries: [
        { path: 'a.md', type: 'file', sha: null },
        { path: 'new-note.md', type: 'file', sha: null },
      ],
    });
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('未同期 Vault への保存は GitHub 直行の従来動作のまま（R2 に反映しない）', async () => {
    const bucket = createFakeR2Bucket();
    mocks.githubApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ content: { sha: 'sha-after-save' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await handleNoteBlobPut(
      putContext(
        putRequest({
          content: toBase64('# saved\n'),
          sha: 'sha-read',
          message: 'Update 2026-08-08.md',
        }),
        PARAMS,
        bucket,
      ),
    );

    expect(response.status).toBe(200);
    expect(await readCachedNote(bucket, 'octocat', 'notes', 'daily/2026-08-08.md')).toBeNull();
    // GitHub へは転送される（旧来の保存経路）
    expect(mocks.githubApiFetch).toHaveBeenCalled();
  });
});
