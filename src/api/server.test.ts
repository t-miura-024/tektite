/**
 * 定時同期（scheduled ハンドラ: runScheduledSync）のユニットテスト（M5）。
 *
 * - 保持中の全 Vault を対象に、KV トークン（getServerAccessToken）で同期する
 * - トークン取得失敗・同期失敗は Vault 単位で meta に記録される（完了条件 10）
 * - 同期衝突（sync_conflict）は中断し、失敗が記録される（次回同期で自動リトライ）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getServerAccessToken: vi.fn(),
  syncVault: vi.fn(),
  listSyncedVaults: vi.fn(),
  recordSyncFailure: vi.fn(),
}));

vi.mock('@/api/_lib/token-store', () => ({
  getServerAccessToken: mocks.getServerAccessToken,
}));

vi.mock('@/api/_lib/vault-sync', () => ({
  listSyncedVaults: mocks.listSyncedVaults,
  recordSyncFailure: mocks.recordSyncFailure,
  syncVault: mocks.syncVault,
}));

import { runScheduledSync } from './server';
import { createFakeR2Bucket } from './_lib/fake-r2';

const ENV_BASE = {
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  OAUTH_REDIRECT_URI: 'http://localhost/api/auth/callback',
} as unknown as Env;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runScheduledSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerAccessToken.mockResolvedValue({ ok: true, accessToken: 'token' });
    mocks.syncVault.mockResolvedValue({
      ok: true,
      result: {
        status: 'synced',
        syncedAt: '2026-08-13T02:00:00.000Z',
        pulled: 0,
        pushed: 0,
        conflicts: [],
      },
    });
    mocks.recordSyncFailure.mockResolvedValue(undefined);
    // ログ出力の抑制
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('保持中の全 Vault をトークンで同期する', async () => {
    const bucket = createFakeR2Bucket();
    mocks.listSyncedVaults.mockResolvedValue([
      { owner: 'octocat', repo: 'notes', meta: {} },
      { owner: 'other', repo: 'vault', meta: {} },
    ]);

    await runScheduledSync({ ...ENV_BASE, VAULT_BUCKET: bucket } as unknown as Env);

    expect(mocks.listSyncedVaults).toHaveBeenCalledWith(bucket);
    expect(mocks.getServerAccessToken).toHaveBeenCalledTimes(2);
    expect(mocks.syncVault).toHaveBeenCalledTimes(2);
    expect(mocks.recordSyncFailure).not.toHaveBeenCalled();
  });

  it('トークン取得に失敗した Vault は失敗を記録して続行する', async () => {
    const bucket = createFakeR2Bucket();
    mocks.listSyncedVaults.mockResolvedValue([
      { owner: 'octocat', repo: 'notes', meta: {} },
      { owner: 'other', repo: 'vault', meta: {} },
    ]);
    mocks.getServerAccessToken
      .mockResolvedValueOnce({ ok: false, reason: 'no_token' })
      .mockResolvedValueOnce({ ok: true, accessToken: 'token' });

    await runScheduledSync({ ...ENV_BASE, VAULT_BUCKET: bucket } as unknown as Env);

    expect(mocks.recordSyncFailure).toHaveBeenCalledWith(bucket, 'octocat', 'notes', 'no_token');
    expect(mocks.syncVault).toHaveBeenCalledTimes(1);
  });

  it('kv_missing（KV バインディング未設定）は no_token に潰さず記録する', async () => {
    const bucket = createFakeR2Bucket();
    mocks.listSyncedVaults.mockResolvedValue([{ owner: 'octocat', repo: 'notes', meta: {} }]);
    mocks.getServerAccessToken.mockResolvedValueOnce({ ok: false, reason: 'kv_missing' });

    await runScheduledSync({ ...ENV_BASE, VAULT_BUCKET: bucket } as unknown as Env);

    expect(mocks.recordSyncFailure).toHaveBeenCalledWith(bucket, 'octocat', 'notes', 'kv_missing');
    expect(mocks.syncVault).not.toHaveBeenCalled();
  });

  it('同期失敗（sync_conflict 含む）は Vault 単位で記録され、次回同期で自動リトライされる', async () => {
    const bucket = createFakeR2Bucket();
    mocks.listSyncedVaults.mockResolvedValue([{ owner: 'octocat', repo: 'notes', meta: {} }]);
    mocks.syncVault.mockResolvedValueOnce({
      ok: false,
      reason: 'sync_conflict',
      response: new Response(null, { status: 409 }),
    });

    await runScheduledSync({ ...ENV_BASE, VAULT_BUCKET: bucket } as unknown as Env);

    expect(mocks.recordSyncFailure).toHaveBeenCalledWith(
      bucket,
      'octocat',
      'notes',
      'sync_conflict',
    );
  });

  it('VAULT_BUCKET 未設定の環境は何もしない', async () => {
    await runScheduledSync(ENV_BASE);
    expect(mocks.listSyncedVaults).not.toHaveBeenCalled();
  });

  it('OAuth 設定がない環境は何もしない（AuthConfigError を握りつぶす）', async () => {
    const bucket = createFakeR2Bucket();
    const env = { VAULT_BUCKET: bucket } as unknown as Env;
    await runScheduledSync(env);
    expect(mocks.listSyncedVaults).not.toHaveBeenCalled();
  });
});
