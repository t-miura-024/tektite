/**
 * ファイルツリーエンドポイント（GET /api/tree/:owner/:repo）のユニットテスト。
 *
 * GitHub プロキシ基盤（github-proxy）をモックして、ツリー応答の整形と
 * 空リポジトリ（Trees API 404）の空ツリー化（M2）を検証する。
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

import { handleTreeGet } from './[repo]';
import { createFakeR2Bucket } from '@/api/_lib/fake-r2';
import { writeVaultMeta, writeVaultTree } from '@/api/_lib/r2-vault';

const ENV = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  GITHUB_API_BASE_URL: 'http://mock.invalid',
} as unknown as Env;

const PARAMS = { owner: 'octocat', repo: 'notes' };

function getContext(params: Record<string, string | string[]> = PARAMS, bucket?: R2Bucket) {
  return {
    env: { ...ENV, ...(bucket === undefined ? {} : { VAULT_BUCKET: bucket }) } as unknown as Env,
    request: new Request('http://localhost/api/tree/octocat/notes'),
    params,
  } as unknown as Parameters<typeof handleTreeGet>[0];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
  mocks.authenticateRequest.mockResolvedValue({ ok: true, token: 'token' });
  mocks.mapGithubFailure.mockReturnValue(null);
  mocks.githubUnreachable.mockReturnValue(
    new Response(JSON.stringify({ error: 'github_unreachable' }), { status: 502 }),
  );
});

describe('GET /api/tree/:owner/:repo', () => {
  it('Trees API の応答を blob / tree エントリに整形して返す', async () => {
    mocks.githubApiFetch.mockImplementation(async (_base: string, path: string) => {
      if (path === '/repos/octocat/notes') {
        return jsonResponse({ default_branch: 'main' });
      }
      if (path.startsWith('/repos/octocat/notes/git/trees/')) {
        return jsonResponse({
          sha: 'tree-sha',
          truncated: false,
          tree: [
            { path: 'a.md', type: 'blob' },
            { path: 'daily', type: 'tree' },
            { path: '.obsidian', type: 'tree' },
          ],
        });
      }
      return jsonResponse({ message: `no mock for ${path}` }, 404);
    });

    const response = await handleTreeGet(getContext());
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      defaultBranch: 'main',
      truncated: false,
      entries: [
        { path: 'a.md', type: 'file' },
        { path: 'daily', type: 'directory' },
        { path: '.obsidian', type: 'directory' },
      ],
    });
  });

  it('空リポジトリ（Trees API 404）は空の entries で 200 を返す（M2）', async () => {
    mocks.githubApiFetch.mockImplementation(async (_base: string, path: string) => {
      if (path === '/repos/octocat/notes') {
        return jsonResponse({ default_branch: 'main' });
      }
      if (path.startsWith('/repos/octocat/notes/git/trees/')) {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      return jsonResponse({ message: `no mock for ${path}` }, 404);
    });
    // 実装と同じ「非 2xx はエラー応答」の挙動でモックする（404 のみ not_found）
    mocks.mapGithubFailure.mockImplementation((response: Response) =>
      response.status === 404
        ? new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
        : null,
    );

    const response = await handleTreeGet(getContext());
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      defaultBranch: 'main',
      truncated: false,
      entries: [],
    });
  });

  it('Trees API の 404 以外の失敗はそのまま変換して返す', async () => {
    mocks.githubApiFetch.mockImplementation(async (_base: string, path: string) => {
      if (path === '/repos/octocat/notes') {
        return jsonResponse({ default_branch: 'main' });
      }
      return jsonResponse({ message: 'rate limited' }, 403);
    });
    mocks.mapGithubFailure.mockReturnValue(
      new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }),
    );

    const response = await handleTreeGet(getContext());
    expect(response.status).toBe(429);
    expect(await readJson(response)).toEqual({ error: 'rate_limited' });
  });
});

describe('GET /api/tree/:owner/:repo（R2 キャッシュ: M3）', () => {
  it('初期同期済み Vault は R2 のツリーを返す（GitHub API を消費しない）', async () => {
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
      entries: [
        { path: 'a.md', type: 'file' },
        { path: 'daily', type: 'directory' },
      ],
    });

    const response = await handleTreeGet(getContext(PARAMS, bucket));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      defaultBranch: 'main',
      truncated: false,
      entries: [
        { path: 'a.md', type: 'file' },
        { path: 'daily', type: 'directory' },
      ],
    });
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('初期同期済みでツリーが R2 に無い場合は GitHub から取得して書き戻す（遅延キャッシュ）', async () => {
    const bucket = createFakeR2Bucket();
    await writeVaultMeta(bucket, 'octocat', 'notes', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: null,
    });
    mocks.githubApiFetch.mockImplementation(async (_base: string, path: string) => {
      if (path === '/repos/octocat/notes') {
        return jsonResponse({ default_branch: 'main' });
      }
      if (path.startsWith('/repos/octocat/notes/git/trees/')) {
        return jsonResponse({
          sha: 'tree-1',
          truncated: false,
          tree: [{ path: 'a.md', type: 'blob' }],
        });
      }
      return jsonResponse({ message: `no mock for ${path}` }, 404);
    });

    const response = await handleTreeGet(getContext(PARAMS, bucket));
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.entries).toEqual([{ path: 'a.md', type: 'file' }]);
    // R2 へ書き戻されている（次の読み取りは R2 から）
    const { readVaultTree } = await import('@/api/_lib/r2-vault');
    const cached = await readVaultTree(bucket, 'octocat', 'notes');
    expect(cached?.treeSha).toBe('tree-1');
    expect(cached?.entries).toEqual([{ path: 'a.md', type: 'file', sha: null }]);
  });

  it('未同期（メタなし）Vault は GitHub 直行で、R2 には書き込まない', async () => {
    const bucket = createFakeR2Bucket();
    mocks.githubApiFetch.mockImplementation(async (_base: string, path: string) => {
      if (path === '/repos/octocat/notes') {
        return jsonResponse({ default_branch: 'main' });
      }
      if (path.startsWith('/repos/octocat/notes/git/trees/')) {
        return jsonResponse({ truncated: false, tree: [{ path: 'a.md', type: 'blob' }] });
      }
      return jsonResponse({ message: `no mock for ${path}` }, 404);
    });

    const response = await handleTreeGet(getContext(PARAMS, bucket));
    expect(response.status).toBe(200);
    // ツリーは R2 に書き込まれない（初期同期が全量を取り込むまで従来挙動）
    const { readVaultTree } = await import('@/api/_lib/r2-vault');
    expect(await readVaultTree(bucket, 'octocat', 'notes')).toBeNull();
  });
});
