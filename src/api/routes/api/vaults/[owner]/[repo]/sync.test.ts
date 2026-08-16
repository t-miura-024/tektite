/**
 * Vault 同期エンドポイント（POST /api/vaults/:owner/:repo/sync, GET .../sync）のユニットテスト。
 *
 * - 既に同期済み（R2 メタあり）で action なしなら GitHub API を消費せず
 *   already_synced を返す
 * - action: 'sync'（明示同期）はツリー sha 比較の差分同期を実行する
 * - 初回は write 権限確認の上で GitHub から全量を取り込み、R2 へ書き込む
 * - GET .../sync は最終同期時刻と失敗マークを返す（完了条件 10）
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

import { handleVaultSyncGet, handleVaultSyncPost } from './sync';
import { listCachedNotes, readVaultMeta, readVaultTree, writeVaultMeta } from '@/api/_lib/r2-vault';

/** テスト用のメモリ R2 バケット */
class FakeR2Bucket {
  private readonly objects = new Map<
    string,
    { body: ArrayBuffer; metadata?: Record<string, string> }
  >();

  async get(key: string): Promise<unknown> {
    const object = this.objects.get(key);
    return object === undefined ? null : new FakeR2ObjectBody(object);
  }

  async put(
    key: string,
    value: string | ArrayBuffer,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown> {
    const body = typeof value === 'string' ? new TextEncoder().encode(value).buffer : value;
    this.objects.set(key, { body, metadata: options?.customMetadata });
    return { key };
  }

  async list(options?: { prefix?: string }): Promise<unknown> {
    const prefix = options?.prefix ?? '';
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    return {
      objects: keys.map((key) => ({ key, size: this.objects.get(key)?.body.byteLength ?? 0 })),
      truncated: false,
      cursor: undefined,
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class FakeR2ObjectBody {
  constructor(private readonly data: { body: ArrayBuffer; metadata?: Record<string, string> }) {}

  get customMetadata(): Record<string, string> {
    return this.data.metadata ?? {};
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data.body;
  }

  async json(): Promise<unknown> {
    return JSON.parse(new TextDecoder().decode(this.data.body));
  }
}

function createBucket(): R2Bucket {
  return new FakeR2Bucket() as unknown as R2Bucket;
}

const ENV_BASE = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  GITHUB_API_BASE_URL: 'http://mock.invalid',
} as unknown as Env;

const PARAMS = { owner: 'octocat', repo: 'notes' };

function getContext(
  bucket: R2Bucket,
  params: Record<string, string | string[]> = PARAMS,
  body?: unknown,
) {
  return {
    env: { ...ENV_BASE, VAULT_BUCKET: bucket } as unknown as Env,
    request: new Request('http://localhost/api/vaults/octocat/notes/sync', {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params,
  } as unknown as Parameters<typeof handleVaultSyncPost>[0];
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

const REPO_INFO = {
  default_branch: 'main',
  permissions: { admin: true, push: true, pull: true },
};

const TREE_RESPONSE = {
  sha: 'tree-sha-1',
  truncated: false,
  tree: [
    { path: '.obsidian', type: 'tree' },
    { path: 'README.md', type: 'blob', sha: 'sha-readme' },
    { path: 'daily', type: 'tree' },
    { path: 'daily/2026-08-13.md', type: 'blob', sha: 'sha-daily' },
    { path: 'attachments/logo.png', type: 'blob', sha: 'sha-logo' },
  ],
};

/** GitHub API のモックを既定の正常系に設定する */
function mockGithubSuccess(): void {
  mocks.githubApiFetch.mockImplementation(async (_base: string, path: string) => {
    if (path === '/repos/octocat/notes') {
      return jsonResponse(REPO_INFO);
    }
    if (path.startsWith('/repos/octocat/notes/git/trees/')) {
      return jsonResponse(TREE_RESPONSE);
    }
    if (path.startsWith('/repos/octocat/notes/git/blobs/')) {
      const sha = path.split('/').at(-1) ?? '';
      const contents: Record<string, string> = {
        'sha-readme': '# README',
        'sha-daily': '# 2026-08-13',
      };
      const content = contents[sha];
      if (content === undefined) {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      return jsonResponse({
        sha,
        encoding: 'base64',
        content: btoa(content),
      });
    }
    return jsonResponse({ message: `no mock for ${path}` }, 404);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveProxyConfig.mockReturnValue({
    sessionSecret: ENV_BASE.SESSION_SECRET,
    apiBaseUrl: ENV_BASE.GITHUB_API_BASE_URL,
  });
  mocks.authenticateRequest.mockResolvedValue({ ok: true, token: 'token' });
  mocks.mapGithubFailure.mockReturnValue(null);
  mocks.githubUnreachable.mockReturnValue(
    new Response(JSON.stringify({ error: 'github_unreachable' }), { status: 502 }),
  );
});

describe('POST /api/vaults/:owner/:repo/sync', () => {
  it('初回は write 権限を確認し、全ノートを R2 へ取り込んで initialized を返す', async () => {
    mockGithubSuccess();
    const bucket = createBucket();

    const response = await handleVaultSyncPost(getContext(bucket));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      status: 'initialized',
      defaultBranch: 'main',
      notes: 2,
    });

    // R2 にメタ / ツリー / ノートが書き込まれている
    const meta = await readVaultMeta(bucket, 'octocat', 'notes');
    expect(meta?.defaultBranch).toBe('main');
    expect(meta?.treeSha).toBe('tree-sha-1');
    const tree = await readVaultTree(bucket, 'octocat', 'notes');
    expect(tree?.entries).toEqual([
      { path: '.obsidian', type: 'directory', sha: null },
      { path: 'README.md', type: 'file', sha: 'sha-readme' },
      { path: 'daily', type: 'directory', sha: null },
      { path: 'daily/2026-08-13.md', type: 'file', sha: 'sha-daily' },
      { path: 'attachments/logo.png', type: 'file', sha: 'sha-logo' },
    ]);
    const notes = await listCachedNotes(bucket, 'octocat', 'notes');
    expect(notes).toEqual([
      { path: 'README.md', note: { sha: 'sha-readme', content: '# README' } },
      { path: 'daily/2026-08-13.md', note: { sha: 'sha-daily', content: '# 2026-08-13' } },
    ]);
  });

  it('既に同期済みで変更がない場合は差分同期して synced を返す（GitHub はツリー 1 回のみ）', async () => {
    mockGithubSuccess();
    const bucket = createBucket();
    const { writeCachedNote, writeVaultMeta: writeMeta } = await import('@/api/_lib/r2-vault');
    await Promise.all([
      writeMeta(bucket, 'octocat', 'notes', {
        syncedAt: '2026-08-13T00:00:00.000Z',
        defaultBranch: 'main',
        treeSha: 'tree-sha-1',
      }),
      writeCachedNote(bucket, 'octocat', 'notes', 'README.md', {
        sha: 'sha-readme',
        content: '# README',
      }),
      writeCachedNote(bucket, 'octocat', 'notes', 'daily/2026-08-13.md', {
        sha: 'sha-daily',
        content: '# 2026-08-13',
      }),
    ]);

    const response = await handleVaultSyncPost(getContext(bucket, PARAMS, { action: 'sync' }));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      status: 'synced',
      defaultBranch: 'main',
      syncedAt: expect.any(String),
      pulled: 0,
      pushed: 0,
      conflicts: [],
    });
    // ツリー sha が同一のため、GitHub API はツリー取得 1 回のみ（変更 blob は取得しない）
    const treeCalls = mocks.githubApiFetch.mock.calls.filter(([, path]) =>
      String(path).includes('/git/trees/'),
    );
    expect(treeCalls).toHaveLength(1);
  });

  it('同期済み Vault を action なしで開いた場合は GitHub に触れず already_synced を返す', async () => {
    const bucket = createBucket();
    await writeVaultMeta(bucket, 'octocat', 'notes', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-sha-1',
    });

    const response = await handleVaultSyncPost(getContext(bucket));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      status: 'already_synced',
      defaultBranch: 'main',
      notes: 0,
    });
    // GitHub API が一切呼ばれないこと（Vault を開くだけでは GitHub API を消費しない）
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('write 権限のないリポジトリは 403 read_only_vault で拒否する', async () => {
    mocks.githubApiFetch.mockImplementation(async (_base: string, path: string) => {
      if (path === '/repos/octocat/notes') {
        return jsonResponse({
          default_branch: 'main',
          permissions: { admin: false, push: false, pull: true },
        });
      }
      return jsonResponse({ message: `no mock for ${path}` }, 404);
    });
    const bucket = createBucket();

    const response = await handleVaultSyncPost(getContext(bucket));
    expect(response.status).toBe(403);
    expect(await readJson(response)).toMatchObject({ error: 'read_only_vault' });
    // 取り込みが行われていない（メタは書かれない）
    expect(await readVaultMeta(bucket, 'octocat', 'notes')).toBeNull();
  });

  it('空リポジトリ（Trees API 404）は空ツリーで initialized を返す', async () => {
    mocks.githubApiFetch.mockImplementation(async (_base: string, path: string) => {
      if (path === '/repos/octocat/notes') {
        return jsonResponse(REPO_INFO);
      }
      if (path.startsWith('/repos/octocat/notes/git/trees/')) {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      return jsonResponse({ message: `no mock for ${path}` }, 404);
    });
    const bucket = createBucket();

    const response = await handleVaultSyncPost(getContext(bucket));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      status: 'initialized',
      defaultBranch: 'main',
      notes: 0,
    });
    const meta = await readVaultMeta(bucket, 'octocat', 'notes');
    expect(meta?.treeSha).toBeNull();
    const tree = await readVaultTree(bucket, 'octocat', 'notes');
    expect(tree?.entries).toEqual([]);
  });

  it('ノート取得の一時的な失敗はリトライで吸収して初期同期を完了する', async () => {
    mockGithubSuccess();
    // sha-daily の blob 取得を 1 回目だけ 404 にし、2 回目で成功させる
    let dailyAttempts = 0;
    mocks.githubApiFetch.mockImplementation(async (_base: string, path: string) => {
      if (path === '/repos/octocat/notes') {
        return jsonResponse(REPO_INFO);
      }
      if (path.startsWith('/repos/octocat/notes/git/trees/')) {
        return jsonResponse(TREE_RESPONSE);
      }
      if (path.startsWith('/repos/octocat/notes/git/blobs/')) {
        if (path.endsWith('sha-daily')) {
          dailyAttempts += 1;
          if (dailyAttempts === 1) {
            return jsonResponse({ message: 'Not Found' }, 404);
          }
          return jsonResponse({ sha: 'sha-daily', encoding: 'base64', content: btoa('# Daily') });
        }
        return jsonResponse({
          sha: 'sha-readme',
          encoding: 'base64',
          content: btoa('# README'),
        });
      }
      return jsonResponse({ message: `no mock for ${path}` }, 404);
    });
    const bucket = createBucket();

    const response = await handleVaultSyncPost(getContext(bucket));
    expect(response.status).toBe(200);
    expect((await readJson(response)).notes).toBe(2);
    expect(dailyAttempts).toBe(2);
    const notes = await listCachedNotes(bucket, 'octocat', 'notes');
    expect(notes.map((entry) => entry.path).toSorted()).toEqual([
      'README.md',
      'daily/2026-08-13.md',
    ]);
  });

  it('ノート取得の失敗（リトライ後も 404）は初期同期を失敗させ、meta を書かない（回帰）', async () => {
    // 2026-08-16 の事故: 取得失敗ノートの「欠落」は、その後の同期 push が
    // 「R2 に無い = 削除」と誤認する原因になった。欠落を許さず、初期同期を
    // 失敗させる（meta が無いため次回の初期同期で全量がやり直される）
    mockGithubSuccess();
    // sha-daily の blob 取得を 404 にする
    mocks.githubApiFetch.mockImplementation(async (_base: string, path: string) => {
      if (path === '/repos/octocat/notes') {
        return jsonResponse(REPO_INFO);
      }
      if (path.startsWith('/repos/octocat/notes/git/trees/')) {
        return jsonResponse(TREE_RESPONSE);
      }
      if (path.startsWith('/repos/octocat/notes/git/blobs/')) {
        if (path.endsWith('sha-daily')) {
          return jsonResponse({ message: 'Not Found' }, 404);
        }
        return jsonResponse({
          sha: 'sha-readme',
          encoding: 'base64',
          content: btoa('# README'),
        });
      }
      return jsonResponse({ message: `no mock for ${path}` }, 404);
    });
    const bucket = createBucket();

    const response = await handleVaultSyncPost(getContext(bucket));
    expect(response.status).toBe(502);
    // 完了マーカーが書かれていないため、R2 は「正」にならない（GitHub 直行が続く）
    expect(await readVaultMeta(bucket, 'octocat', 'notes')).toBeNull();
  });

  it('R2 バインディングがない環境は 503 storage_unavailable を返す', async () => {
    const context = {
      env: ENV_BASE,
      request: new Request('http://localhost/api/vaults/octocat/notes/sync', {
        method: 'POST',
      }),
      params: PARAMS,
    } as unknown as Parameters<typeof handleVaultSyncPost>[0];
    const response = await handleVaultSyncPost(context);
    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({ error: 'storage_unavailable' });
  });

  it('パラメータ不正は 400 invalid_vault_ref を返す', async () => {
    const bucket = createBucket();
    const response = await handleVaultSyncPost(
      getContext(bucket, { owner: 'bad name', repo: 'notes' }),
    );
    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: 'invalid_vault_ref' });
  });

  it('未ログインは 401 unauthenticated を返す', async () => {
    mocks.authenticateRequest.mockResolvedValue({
      ok: false,
      response: Response.json({ error: 'unauthenticated' }, { status: 401 }),
    });
    const bucket = createBucket();
    const response = await handleVaultSyncPost(getContext(bucket));
    expect(response.status).toBe(401);
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/vaults/:owner/:repo/sync（同期状態。完了条件 10）', () => {
  function getStatusContext(bucket: R2Bucket) {
    return {
      env: { ...ENV_BASE, VAULT_BUCKET: bucket } as unknown as Env,
      request: new Request('http://localhost/api/vaults/octocat/notes/sync'),
      params: PARAMS,
    } as unknown as Parameters<typeof handleVaultSyncGet>[0];
  }

  it('最終同期時刻と失敗マーク（定時同期の記録）を返す', async () => {
    const bucket = createBucket();
    await writeVaultMeta(bucket, 'octocat', 'notes', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-1',
      lastSyncError: 'sync_conflict',
      lastFailedAt: '2026-08-13T01:00:00.000Z',
    });

    const response = await handleVaultSyncGet(getStatusContext(bucket));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      syncedAt: '2026-08-13T00:00:00.000Z',
      lastSyncError: 'sync_conflict',
      lastFailedAt: '2026-08-13T01:00:00.000Z',
    });
    // GitHub API は消費しない
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('同期済みで失敗なしの Vault は失敗マークが null で返る', async () => {
    const bucket = createBucket();
    await writeVaultMeta(bucket, 'octocat', 'notes', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-1',
    });

    const response = await handleVaultSyncGet(getStatusContext(bucket));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      syncedAt: '2026-08-13T00:00:00.000Z',
      lastSyncError: null,
      lastFailedAt: null,
    });
  });

  it('未同期（メタなし）の Vault は syncedAt null で返る', async () => {
    const bucket = createBucket();
    const response = await handleVaultSyncGet(getStatusContext(bucket));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      syncedAt: null,
      lastSyncError: null,
      lastFailedAt: null,
    });
  });

  it('R2 バインディングがない環境は 503 storage_unavailable を返す', async () => {
    const context = {
      env: ENV_BASE,
      request: new Request('http://localhost/api/vaults/octocat/notes/sync'),
      params: PARAMS,
    } as unknown as Parameters<typeof handleVaultSyncGet>[0];
    const response = await handleVaultSyncGet(context);
    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({ error: 'storage_unavailable' });
  });
});
