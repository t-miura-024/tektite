/**
 * セッション検証エンドポイント（GET /api/auth/me）のユニットテスト。
 *
 * PAT モード（TEKTITE_PAT_AUTH=true かつ GITHUB_PERSONAL_TOKEN 設定）では OAuth 変数が
 * 不要でログイン済みとして /user を PAT で呼ぶこと、セッション Cookie を無視すること、
 * OAuth モード（従来挙動）を壊さないことを検証する。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  readAccessToken: vi.fn(),
  clearSessionCookie: vi.fn(),
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
  clearSessionCookie: mocks.clearSessionCookie,
  readAccessToken: mocks.readAccessToken,
}));

import { AuthConfigError } from '@/api/_lib/env';
import { handleMeGet } from './me';

const PAT = 'github_pat_test_token';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const API_BASE_URL = 'http://mock.invalid';

function getUserContext(patch: Record<string, string | undefined> = {}) {
  const env = {
    TEKTITE_PAT_AUTH: 'TEKTITE_PAT_AUTH' in patch ? patch.TEKTITE_PAT_AUTH : undefined,
    GITHUB_PERSONAL_TOKEN:
      'GITHUB_PERSONAL_TOKEN' in patch ? patch.GITHUB_PERSONAL_TOKEN : undefined,
    GITHUB_CLIENT_ID: 'GITHUB_CLIENT_ID' in patch ? patch.GITHUB_CLIENT_ID : undefined,
    GITHUB_CLIENT_SECRET: 'GITHUB_CLIENT_SECRET' in patch ? patch.GITHUB_CLIENT_SECRET : undefined,
    SESSION_SECRET: SESSION_SECRET,
    OAUTH_REDIRECT_URI: 'OAUTH_REDIRECT_URI' in patch ? patch.OAUTH_REDIRECT_URI : undefined,
    GITHUB_API_BASE_URL: API_BASE_URL,
  } as unknown as Env;
  return {
    env,
    request: new Request('http://localhost/api/auth/me'),
  } as unknown as Parameters<typeof handleMeGet>[0];
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
  mocks.clearSessionCookie.mockReturnValue('tektite_session=; Max-Age=0; Path=/');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('GET /api/auth/me (PAT モード)', () => {
  it('OAuth 変数が無くても PAT で /user を呼び authenticated: true を返す', async () => {
    const context = getUserContext({
      TEKTITE_PAT_AUTH: 'true',
      GITHUB_PERSONAL_TOKEN: PAT,
    });
    fetchMock.mockResolvedValue(jsonResponse({ login: 'octocat' }));

    const response = await handleMeGet(context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true, login: 'octocat' });
    expect(mocks.resolveAuthConfig).not.toHaveBeenCalled();
    expect(mocks.readAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('PAT モードではセッション Cookie を無視して PAT を使う（PAT 優先）', async () => {
    mocks.readAccessToken.mockResolvedValue('cookie-token');

    const context = getUserContext({
      TEKTITE_PAT_AUTH: 'true',
      GITHUB_PERSONAL_TOKEN: PAT,
    });
    context.request = new Request('http://localhost/api/auth/me', {
      headers: { Cookie: 'tektite_session=stale-cookie' },
    });
    fetchMock.mockResolvedValue(jsonResponse({ login: 'octocat' }));

    const response = await handleMeGet(context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true, login: 'octocat' });
    expect(mocks.readAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/user`, {
      headers: expect.objectContaining({ Authorization: `Bearer ${PAT}` }),
    });
  });

  it('PAT で GitHub が 401 を返したら authenticated: false を返す（Cookie 削除付き）', async () => {
    const context = getUserContext({
      TEKTITE_PAT_AUTH: 'true',
      GITHUB_PERSONAL_TOKEN: PAT,
    });
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Bad credentials' }, 401));

    const response = await handleMeGet(context);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ authenticated: false });
    expect(mocks.clearSessionCookie).toHaveBeenCalled();
  });
});

describe('GET /api/auth/me (OAuth モード)', () => {
  it('OAuth 変数が無ければ従来どおり 401 { authenticated: false }', async () => {
    mocks.resolveAuthConfig.mockImplementation(() => {
      throw new AuthConfigError('環境変数 GITHUB_CLIENT_ID が設定されていません');
    });

    const response = await handleMeGet(getUserContext());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ authenticated: false });
    expect(mocks.readAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('セッション Cookie から復号したトークンで /user を呼びログイン名を返す（従来挙動）', async () => {
    mocks.resolveAuthConfig.mockReturnValue({
      clientId: 'client',
      clientSecret: 'secret',
      sessionSecret: SESSION_SECRET,
      redirectUri: 'http://localhost/api/auth/callback',
      tokenUrl: 'http://mock.invalid/token',
      apiBaseUrl: API_BASE_URL,
    });
    mocks.readAccessToken.mockResolvedValue('cookie-token');
    fetchMock.mockResolvedValue(jsonResponse({ login: 'octocat' }));

    const response = await handleMeGet(getUserContext());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true, login: 'octocat' });
    expect(mocks.readAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/user`, expect.any(Object));
  });

  it('セッション Cookie が無ければ 401 { authenticated: false }', async () => {
    mocks.resolveAuthConfig.mockReturnValue({
      clientId: 'client',
      clientSecret: 'secret',
      sessionSecret: SESSION_SECRET,
      redirectUri: 'http://localhost/api/auth/callback',
      tokenUrl: 'http://mock.invalid/token',
      apiBaseUrl: API_BASE_URL,
    });
    mocks.readAccessToken.mockResolvedValue(null);

    const response = await handleMeGet(getUserContext());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ authenticated: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
