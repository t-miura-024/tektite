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

vi.mock('@functions/api/_lib/github-proxy', () => ({
  ProxyConfigError: class ProxyConfigError extends Error {
    name = 'ProxyConfigError';
  },
  resolveProxyConfig: mocks.resolveProxyConfig,
  authenticateRequest: mocks.authenticateRequest,
  githubApiFetch: mocks.githubApiFetch,
  githubUnreachable: mocks.githubUnreachable,
  mapGithubFailure: mocks.mapGithubFailure,
}));

import { onRequestGet } from './[repo]';

const ENV = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  GITHUB_API_BASE_URL: 'http://mock.invalid',
} as unknown as Env;

const PARAMS = { owner: 'octocat', repo: 'notes' };

function getContext(params: Record<string, string | string[]> = PARAMS) {
  return {
    env: ENV,
    request: new Request('http://localhost/api/tree/octocat/notes'),
    params,
  } as unknown as Parameters<typeof onRequestGet>[0];
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

    const response = await onRequestGet(getContext());
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

    const response = await onRequestGet(getContext());
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

    const response = await onRequestGet(getContext());
    expect(response.status).toBe(429);
    expect(await readJson(response)).toEqual({ error: 'rate_limited' });
  });
});
