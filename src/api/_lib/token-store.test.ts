/**
 * サーバー側トークンストア（KV、ADR-0007）のユニットテスト。
 *
 * - AES-GCM 暗号化（session-crypto 再利用）による保存/復号 round-trip
 * - リフレッシュトークンによる自動延長（getServerAccessToken）
 * - ログイン callback 時の保存条件（KV 設定 / write 権限 scope / /user 解決）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthConfig } from '@/api/_lib/env';
import {
  TokenRefreshError,
  deleteTokenPair,
  getServerAccessToken,
  isAccessTokenExpired,
  persistOAuthTokenPair,
  readTokenPair,
  refreshOAuthToken,
  saveTokenPair,
  tokenKeyForLogin,
} from '@/api/_lib/token-store';
import type { StoredTokenPair } from '@/api/_lib/token-store';

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const API_BASE_URL = 'http://mock.invalid';

const CONFIG: AuthConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  sessionSecret: SESSION_SECRET,
  redirectUri: 'http://localhost/api/auth/callback',
  tokenUrl: 'http://mock.invalid/token',
  apiBaseUrl: API_BASE_URL,
};

/** テスト用の in-memory KV（KVNamespace 互換の最小実装） */
function createKvMock(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saveTokenPair / readTokenPair / deleteTokenPair', () => {
  it('暗号化ペイロードとして KV に保存され、復号 round-trip できる', async () => {
    const { kv, store } = createKvMock();
    const pair: StoredTokenPair = {
      accessToken: 'gho_access',
      refreshToken: 'ghr_refresh',
      expiresAt: 1_800_000_000_000,
    };

    await saveTokenPair(kv, SESSION_SECRET, 'octocat', pair);

    // KV 上の値は AES-GCM 暗号化済みで、平文トークンを直接含まない
    const raw = store.get(tokenKeyForLogin('octocat'));
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('gho_access');
    expect(raw).not.toContain('ghr_refresh');

    await expect(readTokenPair(kv, SESSION_SECRET, 'octocat')).resolves.toEqual(pair);
  });

  it('refreshToken / expiresAt が無い無期限トークンも保存・復号できる', async () => {
    const { kv } = createKvMock();
    await saveTokenPair(kv, SESSION_SECRET, 'octocat', { accessToken: 'gho_access' });

    await expect(readTokenPair(kv, SESSION_SECRET, 'octocat')).resolves.toEqual({
      accessToken: 'gho_access',
    });
  });

  it('KV に未保存の login は null を返す', async () => {
    const { kv } = createKvMock();
    await expect(readTokenPair(kv, SESSION_SECRET, 'octocat')).resolves.toBeNull();
  });

  it('改ざん・別鍵・不正 JSON は null を返す（復号失敗をトークンなしとして扱う）', async () => {
    const { kv, store } = createKvMock();
    await saveTokenPair(kv, SESSION_SECRET, 'octocat', { accessToken: 'gho_access' });

    // 暗号文を破壊する
    const tampered = (store.get(tokenKeyForLogin('octocat')) ?? '') + 'tampered';
    await kv.put(tokenKeyForLogin('octocat'), tampered);
    await expect(readTokenPair(kv, SESSION_SECRET, 'octocat')).resolves.toBeNull();

    // 正しいペイロードで保存し直し、別のシークレットでは復号できない（鍵不一致で null）
    await saveTokenPair(kv, SESSION_SECRET, 'octocat', { accessToken: 'gho_access' });
    await expect(
      readTokenPair(kv, 'another-secret-0123456789abcdef', 'octocat'),
    ).resolves.toBeNull();
    // 正しいシークレットでは読める
    await expect(readTokenPair(kv, SESSION_SECRET, 'octocat')).resolves.toEqual({
      accessToken: 'gho_access',
    });

    // 形式不正（暗号化されていない文字列）も null
    await kv.put(tokenKeyForLogin('octocat'), 'plain-not-encrypted');
    await expect(readTokenPair(kv, SESSION_SECRET, 'octocat')).resolves.toBeNull();
  });

  it('deleteTokenPair で KV エントリを削除する', async () => {
    const { kv, store } = createKvMock();
    await saveTokenPair(kv, SESSION_SECRET, 'octocat', { accessToken: 'gho_access' });

    await deleteTokenPair(kv, 'octocat');

    expect(store.has(tokenKeyForLogin('octocat'))).toBe(false);
    await expect(readTokenPair(kv, SESSION_SECRET, 'octocat')).resolves.toBeNull();
  });
});

describe('isAccessTokenExpired', () => {
  it('expiresAt 未定義（無期限）は期限切れとしない', () => {
    expect(isAccessTokenExpired({ accessToken: 't' }, 1_800_000_000_000)).toBe(false);
  });

  it('期限切れ判定（境界: expiresAt と同時刻は期限切れ）', () => {
    const pair = { accessToken: 't', expiresAt: 1_000 };
    expect(isAccessTokenExpired(pair, 999)).toBe(false);
    expect(isAccessTokenExpired(pair, 1_000)).toBe(true);
    expect(isAccessTokenExpired(pair, 1_001)).toBe(true);
  });
});

describe('refreshOAuthToken', () => {
  it('grant_type=refresh_token で延長し、新しいトークンペアを返す', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'gho_refreshed',
        refresh_token: 'ghr_rotated',
        expires_in: 28800,
        scope: 'repo',
        token_type: 'bearer',
      }),
    );

    const pair = await refreshOAuthToken(CONFIG, 'ghr_refresh');

    expect(pair).toEqual({
      accessToken: 'gho_refreshed',
      refreshToken: 'ghr_rotated',
      expiresAt: expect.any(Number),
    });
    expect(pair.expiresAt).toBeGreaterThan(Date.now());
    expect(fetchMock).toHaveBeenCalledWith(
      CONFIG.tokenUrl,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          client_id: CONFIG.clientId,
          client_secret: CONFIG.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: 'ghr_refresh',
        }),
      }),
    );
  });

  it('GitHub が refresh_token を返さない場合も access token のみ延長できる', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'gho_refreshed' }));

    const pair = await refreshOAuthToken(CONFIG, 'ghr_refresh');

    expect(pair.accessToken).toBe('gho_refreshed');
    expect(pair.refreshToken).toBeUndefined();
    expect(pair.expiresAt).toBeUndefined();
  });

  it('エラー応答（200 + { error } または 4xx）は TokenRefreshError を投げる', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }));
    await expect(refreshOAuthToken(CONFIG, 'ghr_expired')).rejects.toThrow(TokenRefreshError);

    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Bad credentials' }, 401));
    await expect(refreshOAuthToken(CONFIG, 'ghr_bad')).rejects.toThrow(TokenRefreshError);
  });

  it('ネットワーク到達失敗は TokenRefreshError を投げる', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(refreshOAuthToken(CONFIG, 'ghr_refresh')).rejects.toThrow(TokenRefreshError);
  });
});

describe('getServerAccessToken（Cron 同期用・Cookie なし）', () => {
  it('KV バインディング未設定は kv_missing', async () => {
    const env = {} as Env;
    const result = await getServerAccessToken(env, CONFIG, 'octocat');
    expect(result).toEqual({ ok: false, reason: 'kv_missing' });
  });

  it('KV にトークンが無い login は no_token', async () => {
    const { kv } = createKvMock();
    const result = await getServerAccessToken({ TOKEN_KV: kv } as Env, CONFIG, 'octocat');
    expect(result).toEqual({ ok: false, reason: 'no_token' });
  });

  it('期限切れでないアクセストークンをそのまま返す', async () => {
    const { kv } = createKvMock();
    await saveTokenPair(kv, SESSION_SECRET, 'octocat', {
      accessToken: 'gho_valid',
      expiresAt: Date.now() + 60_000,
    });

    const result = await getServerAccessToken({ TOKEN_KV: kv } as Env, CONFIG, 'octocat');

    expect(result).toEqual({ ok: true, accessToken: 'gho_valid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('期限切れならリフレッシュトークンで自動延長し、結果を KV に保存し直す', async () => {
    const { kv } = createKvMock();
    await saveTokenPair(kv, SESSION_SECRET, 'octocat', {
      accessToken: 'gho_expired',
      refreshToken: 'ghr_refresh',
      expiresAt: 1_000,
    });
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'gho_refreshed',
        refresh_token: 'ghr_rotated',
        expires_in: 28800,
        scope: 'repo',
      }),
    );

    const result = await getServerAccessToken({ TOKEN_KV: kv } as Env, CONFIG, 'octocat', 2_000);

    expect(result).toEqual({ ok: true, accessToken: 'gho_refreshed' });
    // 保存し直された新しいペアが読める（refresh トークンもローテーション済み）
    await expect(readTokenPair(kv, SESSION_SECRET, 'octocat')).resolves.toEqual({
      accessToken: 'gho_refreshed',
      refreshToken: 'ghr_rotated',
      expiresAt: expect.any(Number),
    });
  });

  it('期限切れだがリフレッシュトークンが無いトークンは no_refresh_token', async () => {
    const { kv } = createKvMock();
    await saveTokenPair(kv, SESSION_SECRET, 'octocat', {
      accessToken: 'gho_expired',
      expiresAt: 1_000,
    });

    const result = await getServerAccessToken({ TOKEN_KV: kv } as Env, CONFIG, 'octocat', 2_000);

    expect(result).toEqual({ ok: false, reason: 'no_refresh_token' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('リフレッシュ失敗（無効な refresh token）は refresh_failed', async () => {
    const { kv } = createKvMock();
    await saveTokenPair(kv, SESSION_SECRET, 'octocat', {
      accessToken: 'gho_expired',
      refreshToken: 'ghr_invalid',
      expiresAt: 1_000,
    });
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }));

    const result = await getServerAccessToken({ TOKEN_KV: kv } as Env, CONFIG, 'octocat', 2_000);

    expect(result).toEqual({ ok: false, reason: 'refresh_failed' });
    // リフレッシュ失敗時は既存ペアを保持する（無期限に invalid にならない）
    await expect(readTokenPair(kv, SESSION_SECRET, 'octocat')).resolves.toEqual({
      accessToken: 'gho_expired',
      refreshToken: 'ghr_invalid',
      expiresAt: 1_000,
    });
  });
});

describe('persistOAuthTokenPair（ログイン callback 時の保存）', () => {
  it('KV バインディング未設定では保存しない（Cookie フローは従来通り）', async () => {
    const result = await persistOAuthTokenPair({} as Env, CONFIG, {
      access_token: 'gho_access',
      scope: 'repo',
    });
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('write 権限なし（scope に repo が含まれない）は保存しない', async () => {
    const { kv } = createKvMock();
    const result = await persistOAuthTokenPair({ TOKEN_KV: kv } as Env, CONFIG, {
      access_token: 'gho_access',
      scope: 'read:org',
    });
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('write 権限（scope=repo）ありなら /user で login を解決し、暗号化保存する', async () => {
    const { kv, store } = createKvMock();
    fetchMock.mockResolvedValue(jsonResponse({ login: 'octocat' }));

    const result = await persistOAuthTokenPair({ TOKEN_KV: kv } as Env, CONFIG, {
      access_token: 'gho_access',
      refresh_token: 'ghr_refresh',
      expires_in: 28800,
      scope: 'repo',
    });

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/user`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer gho_access' }),
      }),
    );
    // KV 上は暗号化済み（平文トークンを含まない）
    const raw = store.get(tokenKeyForLogin('octocat'));
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('gho_access');
    const pair = await readTokenPair(kv, SESSION_SECRET, 'octocat');
    expect(pair).toEqual({
      accessToken: 'gho_access',
      refreshToken: 'ghr_refresh',
      expiresAt: expect.any(Number),
    });
    expect(pair?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('/user が失敗（401 など）したら保存しない', async () => {
    const { kv } = createKvMock();
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Bad credentials' }, 401));

    const result = await persistOAuthTokenPair({ TOKEN_KV: kv } as Env, CONFIG, {
      access_token: 'gho_access',
      scope: 'repo',
    });

    expect(result).toBe(false);
    await expect(readTokenPair(kv, SESSION_SECRET, 'octocat')).resolves.toBeNull();
  });

  it('/user が login を返さない不正応答は保存しない', async () => {
    const { kv } = createKvMock();
    fetchMock.mockResolvedValue(jsonResponse({ id: 583231 }));

    const result = await persistOAuthTokenPair({ TOKEN_KV: kv } as Env, CONFIG, {
      access_token: 'gho_access',
      scope: 'repo',
    });

    expect(result).toBe(false);
  });
});
