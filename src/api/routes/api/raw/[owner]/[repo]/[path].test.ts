/**
 * 画像 raw 配信エンドポイント（GET /api/raw/:owner/:repo/:path）のユニットテスト。
 *
 * 実ネットワークを使わず、GitHub プロキシ基盤（github-proxy）の
 * githubApiFetch / mapGithubFailure をモックして、認証・パス検証・
 * バイナリ応答のパススルーを検証する。
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
import { handleRawGet } from './[path]';
import { createFakeR2Bucket } from '@/api/_lib/fake-r2';
import { readCachedRaw, writeCachedRaw, writeVaultMeta, writeVaultTree } from '@/api/_lib/r2-vault';

const ENV = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  GITHUB_API_BASE_URL: 'http://mock.invalid',
} as unknown as Env;

const PARAMS = { owner: 'octocat', repo: 'notes', path: 'attachments%2Flogo.png' };

function getContext(
  request: Request,
  params: Record<string, string | string[]> = PARAMS,
  bucket?: R2Bucket,
): Parameters<typeof handleRawGet>[0] {
  return {
    env: {
      ...ENV,
      ...(bucket === undefined ? {} : { VAULT_BUCKET: bucket }),
    } as unknown as Env,
    request,
    params,
  } as unknown as Parameters<typeof handleRawGet>[0];
}

function getRequest(path: string): Request {
  return new Request(`http://localhost/api/raw${path}`);
}

function okAuth() {
  mocks.authenticateRequest.mockResolvedValue({ ok: true, token: 'token' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveProxyConfig.mockReturnValue({
    sessionSecret: ENV.SESSION_SECRET,
    apiBaseUrl: ENV.GITHUB_API_BASE_URL,
  });
  // 既定は成功（GitHub の失敗変換は各テストで上書きする）
  mocks.mapGithubFailure.mockReturnValue(null);
});

describe('handleRawGet', () => {
  it('不正な owner / repo は 400', async () => {
    const response = await handleRawGet(
      getContext(getRequest('/bad owner/notes/x.png'), {
        owner: 'bad owner',
        repo: 'notes',
        path: 'x.png',
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_vault_ref' });
  });

  it('空のパスは 400', async () => {
    const response = await handleRawGet(
      getContext(getRequest('/octocat/notes/'), { owner: 'octocat', repo: 'notes', path: '' }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_raw_path' });
  });

  it('未ログインは 401（認証応答をそのまま返す）', async () => {
    const unauthorized = Response.json({ error: 'unauthenticated' }, { status: 401 });
    mocks.authenticateRequest.mockResolvedValue({ ok: false, response: unauthorized });
    const response = await handleRawGet(getContext(getRequest('/octocat/notes/a.png')));
    expect(response.status).toBe(401);
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('GitHub の失敗を error envelope に変換して返す', async () => {
    okAuth();
    const failure = Response.json({ error: 'not_found' }, { status: 404 });
    mocks.githubApiFetch.mockResolvedValue(failure);
    mocks.mapGithubFailure.mockReturnValue(failure);
    const response = await handleRawGet(getContext(getRequest('/octocat/notes/a.png')));
    expect(response.status).toBe(404);
    expect(mocks.githubApiFetch).toHaveBeenCalledWith(
      'http://mock.invalid',
      '/repos/octocat/notes/contents/attachments/logo.png',
      'token',
      { headers: { Accept: 'application/vnd.github.raw' } },
    );
  });

  it('正常系はバイナリ本文を Content-Type 付きでパススルーする', async () => {
    okAuth();
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const github = new Response(binary, {
      headers: { 'Content-Type': 'image/png' },
    });
    mocks.githubApiFetch.mockResolvedValue(github);
    const response = await handleRawGet(getContext(getRequest('/octocat/notes/logo.png')));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(binary);
  });

  it('GitHub 到達不能は 502', async () => {
    okAuth();
    mocks.githubApiFetch.mockRejectedValue(new Error('network'));
    mocks.githubUnreachable.mockReturnValue(
      Response.json({ error: 'github_unreachable' }, { status: 502 }),
    );
    const response = await handleRawGet(getContext(getRequest('/octocat/notes/a.png')));
    expect(response.status).toBe(502);
  });
});

describe('handleRawGet（R2 キャッシュ: M3）', () => {
  it('初期同期済み Vault は R2 のバイナリを返す（GitHub API を消費しない）', async () => {
    okAuth();
    const bucket = createFakeR2Bucket();
    await writeVaultMeta(bucket, 'octocat', 'notes', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-1',
    });
    const body = new TextEncoder().encode('png-from-r2').buffer;
    await writeCachedRaw(bucket, 'octocat', 'notes', 'attachments/logo.png', body, 'image/png');

    const response = await handleRawGet(
      getContext(getRequest('/octocat/notes/attachments%2Flogo.png'), PARAMS, bucket),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('png-from-r2');
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('R2 に無い Attachment は GitHub から取得して書き戻す（遅延キャッシュ）', async () => {
    okAuth();
    const bucket = createFakeR2Bucket();
    await writeVaultMeta(bucket, 'octocat', 'notes', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-1',
    });
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    mocks.githubApiFetch.mockResolvedValue(
      new Response(binary, { headers: { 'Content-Type': 'image/png' } }),
    );

    const response = await handleRawGet(
      getContext(getRequest('/octocat/notes/attachments%2Flogo.png'), PARAMS, bucket),
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(binary);
    // 書き戻されている（次の読み取りは R2 から）
    const cached = await readCachedRaw(bucket, 'octocat', 'notes', 'attachments/logo.png');
    expect(new Uint8Array(cached?.body ?? new ArrayBuffer(0))).toEqual(binary);
    expect(cached?.contentType).toBe('image/png');
  });

  it('メタなし（未同期）Vault は R2 を読まず GitHub 直行で、書き戻さない', async () => {
    okAuth();
    const bucket = createFakeR2Bucket();
    mocks.githubApiFetch.mockResolvedValue(
      new Response(new Uint8Array([0x01]), { headers: { 'Content-Type': 'image/png' } }),
    );

    const response = await handleRawGet(
      getContext(getRequest('/octocat/notes/attachments%2Flogo.png'), PARAMS, bucket),
    );
    expect(response.status).toBe(200);
    expect(await readCachedRaw(bucket, 'octocat', 'notes', 'attachments/logo.png')).toBeNull();
  });

  it('ツリーに無いパスは 404 を返し、GitHub から復活させない（M4: 削除済み添付）', async () => {
    okAuth();
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
      entries: [{ path: 'attachments/kept.png', type: 'file' }],
    });
    mocks.githubApiFetch.mockResolvedValue(
      new Response(new Uint8Array([0x01]), { headers: { 'Content-Type': 'image/png' } }),
    );

    const response = await handleRawGet(
      getContext(getRequest('/octocat/notes/attachments%2Fdeleted.png'), PARAMS, bucket),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });
});
