/**
 * GitHub API プロキシ基盤（github-proxy）のユニットテスト。
 *
 * PAT モード（TEKTITE_PAT_AUTH=true かつ GITHUB_PERSONAL_TOKEN 設定）の
 * 有効/無効の判定、SESSION_SECRET 不要化、PAT 優先（Cookie を読まない）を検証する。
 * OAuth モード（従来挙動）のセッション Cookie 認証も併せて確認する。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readAccessToken: vi.fn(),
}));

vi.mock('@functions/api/auth/_lib/session', () => ({
  clearSessionCookie: vi.fn().mockReturnValue('tektite_session=; Max-Age=0; Path=/'),
  readAccessToken: mocks.readAccessToken,
}));

import { readAccessToken } from '@functions/api/auth/_lib/session';
import {
  authenticateRequest,
  isPatModeEnabled,
  resolveProxyConfig,
} from '@functions/api/_lib/github-proxy';

const PAT = 'github_pat_test_token';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

function buildEnv(patch: Record<string, string | undefined> = {}): Env {
  return {
    TEKTITE_PAT_AUTH: 'TEKTITE_PAT_AUTH' in patch ? patch.TEKTITE_PAT_AUTH : undefined,
    GITHUB_PERSONAL_TOKEN:
      'GITHUB_PERSONAL_TOKEN' in patch ? patch.GITHUB_PERSONAL_TOKEN : undefined,
    SESSION_SECRET: 'SESSION_SECRET' in patch ? patch.SESSION_SECRET : SESSION_SECRET,
    GITHUB_API_BASE_URL:
      'GITHUB_API_BASE_URL' in patch ? patch.GITHUB_API_BASE_URL : 'http://mock.invalid',
  } as unknown as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isPatModeEnabled', () => {
  it('TEKTITE_PAT_AUTH === "true" かつ GITHUB_PERSONAL_TOKEN 非空の時のみ有効', () => {
    expect(
      isPatModeEnabled(buildEnv({ TEKTITE_PAT_AUTH: 'true', GITHUB_PERSONAL_TOKEN: PAT })),
    ).toBe(true);
  });

  it('フラグが欠けている・値が異なる・トークンが空の場合は無効', () => {
    expect(isPatModeEnabled(buildEnv({ GITHUB_PERSONAL_TOKEN: PAT }))).toBe(false);
    expect(isPatModeEnabled(buildEnv({ TEKTITE_PAT_AUTH: '1', GITHUB_PERSONAL_TOKEN: PAT }))).toBe(
      false,
    );
    expect(
      isPatModeEnabled(buildEnv({ TEKTITE_PAT_AUTH: 'TRUE', GITHUB_PERSONAL_TOKEN: PAT })),
    ).toBe(false);
    expect(isPatModeEnabled(buildEnv({ TEKTITE_PAT_AUTH: 'true' }))).toBe(false);
    expect(
      isPatModeEnabled(buildEnv({ TEKTITE_PAT_AUTH: 'true', GITHUB_PERSONAL_TOKEN: '' })),
    ).toBe(false);
  });
});

describe('resolveProxyConfig', () => {
  it('PAT モードでは SESSION_SECRET 不要で patToken を返す', () => {
    const config = resolveProxyConfig(
      buildEnv({ TEKTITE_PAT_AUTH: 'true', GITHUB_PERSONAL_TOKEN: PAT }),
    );
    expect(config).toEqual({
      sessionSecret: null,
      patToken: PAT,
      apiBaseUrl: 'http://mock.invalid',
    });
  });

  it('PAT モードでは OAuth の SESSION_SECRET が空でもエラーにならない', () => {
    const env = buildEnv({
      TEKTITE_PAT_AUTH: 'true',
      GITHUB_PERSONAL_TOKEN: PAT,
      SESSION_SECRET: undefined,
    });
    expect(() => resolveProxyConfig(env)).not.toThrow();
    expect(resolveProxyConfig(env).patToken).toBe(PAT);
  });

  it('OAuth モード（PAT 無効）では従来どおり SESSION_SECRET が必要', () => {
    const config = resolveProxyConfig(buildEnv());
    expect(config).toEqual({
      sessionSecret: SESSION_SECRET,
      patToken: null,
      apiBaseUrl: 'http://mock.invalid',
    });
  });

  it('OAuth モードで SESSION_SECRET が無ければ ProxyConfigError を投げる', () => {
    const env = buildEnv({ SESSION_SECRET: undefined });
    expect(() => resolveProxyConfig(env)).toThrow('SESSION_SECRET');
  });
});

describe('authenticateRequest', () => {
  it('PAT モードでは Cookie を一切読まず常に PAT を返す（PAT 優先）', async () => {
    mocks.readAccessToken.mockResolvedValue('cookie-token');
    const config = resolveProxyConfig(
      buildEnv({ TEKTITE_PAT_AUTH: 'true', GITHUB_PERSONAL_TOKEN: PAT }),
    );

    const result = await authenticateRequest(new Request('http://localhost/api/vaults'), config);

    expect(readAccessToken).not.toHaveBeenCalled();
    if (!result.ok) throw new Error('expected ok');
    expect(result.token).toBe(PAT);
  });

  it('OAuth モードではセッション Cookie から復号したトークンを使う', async () => {
    mocks.readAccessToken.mockResolvedValue('cookie-token');
    const config = resolveProxyConfig(buildEnv());

    const result = await authenticateRequest(new Request('http://localhost/api/vaults'), config);

    expect(readAccessToken).toHaveBeenCalledTimes(1);
    if (!result.ok) throw new Error('expected ok');
    expect(result.token).toBe('cookie-token');
  });

  it('OAuth モードで Cookie が無ければ 401 応答を返す', async () => {
    mocks.readAccessToken.mockResolvedValue(null);
    const config = resolveProxyConfig(buildEnv());

    const result = await authenticateRequest(new Request('http://localhost/api/vaults'), config);

    if (result.ok) throw new Error('expected auth failure');
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toEqual({ error: 'unauthenticated' });
  });
});
