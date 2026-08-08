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

// eslint-disable-next-line import/first -- vi.mock は import より前に置く必要がある
import { onRequestGet } from './[path]';

const ENV = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  GITHUB_API_BASE_URL: 'http://mock.invalid',
} as unknown as Env;

const PARAMS = { owner: 'octocat', repo: 'notes', path: 'attachments%2Flogo.png' };

function getContext(
  request: Request,
  params: Record<string, string | string[]> = PARAMS,
): Parameters<typeof onRequestGet>[0] {
  return { env: ENV, request, params } as unknown as Parameters<typeof onRequestGet>[0];
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

describe('onRequestGet', () => {
  it('不正な owner / repo は 400', async () => {
    const response = await onRequestGet(
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
    const response = await onRequestGet(
      getContext(getRequest('/octocat/notes/'), { owner: 'octocat', repo: 'notes', path: '' }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_raw_path' });
  });

  it('未ログインは 401（認証応答をそのまま返す）', async () => {
    const unauthorized = Response.json({ error: 'unauthenticated' }, { status: 401 });
    mocks.authenticateRequest.mockResolvedValue({ ok: false, response: unauthorized });
    const response = await onRequestGet(getContext(getRequest('/octocat/notes/a.png')));
    expect(response.status).toBe(401);
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('GitHub の失敗を error envelope に変換して返す', async () => {
    okAuth();
    const failure = Response.json({ error: 'not_found' }, { status: 404 });
    mocks.githubApiFetch.mockResolvedValue(failure);
    mocks.mapGithubFailure.mockReturnValue(failure);
    const response = await onRequestGet(getContext(getRequest('/octocat/notes/a.png')));
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
    const response = await onRequestGet(getContext(getRequest('/octocat/notes/logo.png')));
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
    const response = await onRequestGet(getContext(getRequest('/octocat/notes/a.png')));
    expect(response.status).toBe(502);
  });
});
