/**
 * OAuth コールバック（GET /api/auth/callback）のユニットテスト。
 *
 * KV へのトークン保存（ADR-0007）はベストエフォートであり、保存失敗・
 * 保存スキップ・KV 未設定でもログイン（Cookie 発行 + リダイレクト）が
 * 従来通り成立することを検証する。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  verifyStateCookie: vi.fn(),
  verifyReturnToCookie: vi.fn(),
  createSessionCookie: vi.fn(),
  clearStateCookie: vi.fn(),
  clearReturnToCookie: vi.fn(),
  persistOAuthTokenPair: vi.fn(),
}));

vi.mock('@/api/_lib/env', () => {
  class AuthConfigError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AuthConfigError';
    }
  }
  return { AuthConfigError, resolveAuthConfig: mocks.resolveAuthConfig };
});

vi.mock('@/api/_lib/session', () => ({
  clearReturnToCookie: mocks.clearReturnToCookie,
  clearStateCookie: mocks.clearStateCookie,
  createSessionCookie: mocks.createSessionCookie,
  verifyReturnToCookie: mocks.verifyReturnToCookie,
  verifyStateCookie: mocks.verifyStateCookie,
}));

vi.mock('@/api/_lib/token-store', () => ({
  persistOAuthTokenPair: mocks.persistOAuthTokenPair,
}));

import { handleCallbackGet } from './callback';

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const TOKEN_URL = 'http://mock.invalid/token';

const CONFIG = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  sessionSecret: SESSION_SECRET,
  redirectUri: 'http://localhost/api/auth/callback',
  tokenUrl: TOKEN_URL,
  apiBaseUrl: 'http://mock.invalid',
};

function getContext(
  env: Record<string, unknown> = {},
  extra: { code?: string; state?: string } = {},
) {
  const url = new URL('http://localhost/api/auth/callback');
  url.searchParams.set('code', extra.code ?? 'e2e-test-code');
  url.searchParams.set('state', extra.state ?? 'test-state');
  return {
    env: env as Env,
    request: new Request(url),
  } as unknown as Parameters<typeof handleCallbackGet>[0];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);

  mocks.resolveAuthConfig.mockReturnValue(CONFIG);
  mocks.verifyStateCookie.mockResolvedValue(true);
  mocks.verifyReturnToCookie.mockResolvedValue('/octocat/notes');
  mocks.createSessionCookie.mockResolvedValue('tektite_session=encrypted; Path=/; HttpOnly');
  mocks.clearStateCookie.mockReturnValue('tektite_oauth_state=; Max-Age=0; Path=/');
  mocks.clearReturnToCookie.mockReturnValue('tektite_return_to=; Max-Age=0; Path=/');
  mocks.persistOAuthTokenPair.mockResolvedValue(true);
});

function mockTokenExchange(body: unknown, status = 200) {
  fetchMock.mockResolvedValue(jsonResponse(body, status));
}

describe('GET /api/auth/callback（KV トークン保存つき）', () => {
  it('トークン交換後に KV 保存を呼び、リダイレクト + セッション Cookie を返す', async () => {
    mockTokenExchange({
      access_token: 'gho_access',
      refresh_token: 'ghr_refresh',
      expires_in: 28800,
      scope: 'repo',
      token_type: 'bearer',
    });

    const response = await handleCallbackGet(getContext({ TOKEN_KV: {} }));

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/octocat/notes');
    expect(response.headers.get('Set-Cookie')).toContain('tektite_session=encrypted');
    expect(mocks.persistOAuthTokenPair).toHaveBeenCalledTimes(1);
    expect(mocks.persistOAuthTokenPair).toHaveBeenCalledWith(
      expect.objectContaining({ TOKEN_KV: {} }),
      CONFIG,
      {
        access_token: 'gho_access',
        refresh_token: 'ghr_refresh',
        expires_in: 28800,
        scope: 'repo',
        token_type: 'bearer',
      },
    );
  });

  it('KV 保存が失敗してもログインは成功する（ベストエフォート）', async () => {
    mockTokenExchange({ access_token: 'gho_access', scope: 'repo' });
    mocks.persistOAuthTokenPair.mockRejectedValue(new Error('kv write failed'));

    const response = await handleCallbackGet(getContext({ TOKEN_KV: {} }));

    expect(response.status).toBe(302);
    expect(response.headers.get('Set-Cookie')).toContain('tektite_session=encrypted');
  });

  it('KV 保存がスキップ（write 権限なし）でもログインは成功する', async () => {
    mockTokenExchange({ access_token: 'gho_access', scope: 'read:org' });
    mocks.persistOAuthTokenPair.mockResolvedValue(false);

    const response = await handleCallbackGet(getContext({ TOKEN_KV: {} }));

    expect(response.status).toBe(302);
    expect(response.headers.get('Set-Cookie')).toContain('tektite_session=encrypted');
    expect(mocks.persistOAuthTokenPair).toHaveBeenCalledTimes(1);
  });

  it('KV バインディング未設定でも従来通りのログインが成立する', async () => {
    mockTokenExchange({ access_token: 'gho_access', scope: 'repo' });
    mocks.persistOAuthTokenPair.mockResolvedValue(false);

    const response = await handleCallbackGet(getContext());

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/octocat/notes');
    expect(response.headers.get('Set-Cookie')).toContain('tektite_session=encrypted');
  });
});
