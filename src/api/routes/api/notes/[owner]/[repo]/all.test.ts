/**
 * ノート一括取得エンドポイント（GET /api/notes/:owner/:repo/all）のユニットテスト。
 *
 * 実ネットワークを使わず、GitHub プロキシ基盤（github-proxy）の githubApiFetch /
 * mapGithubFailure をモックして、ツリー由来の Markdown blob 抽出・Blob 並列取得・
 * 個別失敗の除外・応答整形を検証する。
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
import { handleNotesAllGet } from './all';
import { createFakeR2Bucket } from '@/api/_lib/fake-r2';
import { writeCachedNote, writeVaultMeta } from '@/api/_lib/r2-vault';

const ENV = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  GITHUB_API_BASE_URL: 'http://mock.invalid',
} as unknown as Env;

const PARAMS = { owner: 'octocat', repo: 'notes' };

/** ASCII 本文を base64 にエンコードする（テストデータは ASCII のみ） */
function toBase64(text: string): string {
  return btoa(text);
}

/** GitHub API の応答をモックする（URL で種別を振り分ける） */
function mockGithubApi(notes: Record<string, string>): void {
  mocks.githubApiFetch.mockImplementation(async (_baseUrl: string, path: string) => {
    if (path === '/repos/octocat/notes') {
      return new Response(JSON.stringify({ default_branch: 'main' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.startsWith('/repos/octocat/notes/git/trees/')) {
      const entries = Object.entries(notes).map(([pathKey, _content], index) => ({
        path: pathKey,
        type: 'blob',
        sha: `sha-${index}`,
      }));
      return new Response(JSON.stringify({ truncated: false, tree: entries }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.startsWith('/repos/octocat/notes/git/blobs/')) {
      const sha = path.split('/').pop() ?? '';
      const index = Number(sha.replace('sha-', ''));
      const content = Object.values(notes)[index];
      if (content === undefined) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ sha, encoding: 'base64', content: toBase64(content) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  });
}

function getContext(bucket?: R2Bucket): Parameters<typeof handleNotesAllGet>[0] {
  return {
    env: {
      ...ENV,
      ...(bucket === undefined ? {} : { VAULT_BUCKET: bucket }),
    } as unknown as Env,
    request: new Request('http://localhost/api/notes/octocat/notes/all'),
    params: PARAMS,
  } as unknown as Parameters<typeof handleNotesAllGet>[0];
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
  mocks.mapGithubFailure.mockImplementation((response: Response) =>
    response.ok ? null : Response.json({ error: 'github_error' }, { status: response.status }),
  );
});

describe('GET /api/notes/:owner/:repo/all', () => {
  it('Markdown ノートの一覧（path / sha / content）を 1 応答で返す', async () => {
    mockGithubApi({
      'README.md': '# README\n',
      'daily/2026-08-08.md': '# daily\n',
    });

    const response = await handleNotesAllGet(getContext());

    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toEqual({
      owner: 'octocat',
      name: 'notes',
      defaultBranch: 'main',
      truncated: false,
      notes: [
        { path: 'README.md', sha: 'sha-0', content: '# README\n' },
        { path: 'daily/2026-08-08.md', sha: 'sha-1', content: '# daily\n' },
      ],
    });
  });

  it('Markdown 以外のファイル（画像 / JSON / ディレクトリ）は取得対象に含めない', async () => {
    mockGithubApi({
      'README.md': '# README\n',
      'attachments/logo.png': 'image',
      'config.json': '{}',
    });

    const response = await handleNotesAllGet(getContext());

    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.notes).toEqual([{ path: 'README.md', sha: 'sha-0', content: '# README\n' }]);
    // Blob 取得は .md 分だけ（1 件）呼ばれる
    const blobCalls = mocks.githubApiFetch.mock.calls.filter(([, path]) =>
      String(path).includes('/git/blobs/'),
    );
    expect(blobCalls).toHaveLength(1);
  });

  it('8 件を超えるノートもチャンク分割して全件取得する', async () => {
    const notes: Record<string, string> = {};
    for (let index = 0; index < 17; index += 1) {
      notes[`note-${index}.md`] = `# note ${index}\n`;
    }
    mockGithubApi(notes);

    const response = await handleNotesAllGet(getContext());

    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.notes).toHaveLength(17);
    const blobCalls = mocks.githubApiFetch.mock.calls.filter(([, path]) =>
      String(path).includes('/git/blobs/'),
    );
    expect(blobCalls).toHaveLength(17);
  });

  it('個別 blob の取得失敗（404 等）は応答から除外する', async () => {
    mockGithubApi({ 'README.md': '# README\n' });
    // sha-0 だけ 404 を返す（ツリーには 2 件あるが 1 件失敗する）
    mocks.githubApiFetch.mockImplementation(async (_baseUrl: string, path: string) => {
      if (path === '/repos/octocat/notes') {
        return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
      }
      if (path.startsWith('/repos/octocat/notes/git/trees/')) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              { path: 'a.md', type: 'blob', sha: 'sha-a' },
              { path: 'b.md', type: 'blob', sha: 'sha-b' },
            ],
          }),
          { status: 200 },
        );
      }
      if (path === '/repos/octocat/notes/git/blobs/sha-a') {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      if (path === '/repos/octocat/notes/git/blobs/sha-b') {
        return new Response(
          JSON.stringify({ sha: 'sha-b', encoding: 'base64', content: toBase64('# b\n') }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    });

    const response = await handleNotesAllGet(getContext());

    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.notes).toEqual([{ path: 'b.md', sha: 'sha-b', content: '# b\n' }]);
  });

  it('ツリーの truncated フラグを応答に含める', async () => {
    mocks.githubApiFetch.mockImplementation(async (_baseUrl: string, path: string) => {
      if (path === '/repos/octocat/notes') {
        return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
      }
      if (path.startsWith('/repos/octocat/notes/git/trees/')) {
        return new Response(JSON.stringify({ truncated: true, tree: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    });

    const response = await handleNotesAllGet(getContext());

    expect(response.status).toBe(200);
    expect((await readJson(response)).truncated).toBe(true);
  });

  it('空リポジトリ（Trees API 404）は空の notes で 200 を返す（M2）', async () => {
    mocks.githubApiFetch.mockImplementation(async (_baseUrl: string, path: string) => {
      if (path === '/repos/octocat/notes') {
        return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
      }
      if (path.startsWith('/repos/octocat/notes/git/trees/')) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    });

    const response = await handleNotesAllGet(getContext());

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      defaultBranch: 'main',
      truncated: false,
      notes: [],
    });
    // 空のため Blob 取得は 1 回も呼ばれない
    const blobCalls = mocks.githubApiFetch.mock.calls.filter(([, path]) =>
      String(path).includes('/git/blobs/'),
    );
    expect(blobCalls).toHaveLength(0);
  });

  it('未認証は 401 を返し、GitHub API を呼ばない', async () => {
    mocks.authenticateRequest.mockResolvedValue({
      ok: false,
      response: Response.json({ error: 'unauthenticated' }, { status: 401 }),
    });

    const response = await handleNotesAllGet(getContext());

    expect(response.status).toBe(401);
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('不正な owner / repo は 400 invalid_vault_ref', async () => {
    const response = await handleNotesAllGet({
      env: ENV,
      request: new Request('http://localhost/api/notes/bad%20owner/notes/all'),
      params: { ...PARAMS, owner: 'bad owner!' },
    } as unknown as Parameters<typeof handleNotesAllGet>[0]);

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: 'invalid_vault_ref' });
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('リポジトリ情報の取得失敗（404）は mapGithubFailure の応答をそのまま返す', async () => {
    mocks.mapGithubFailure.mockImplementation(() =>
      Response.json({ error: 'not_found' }, { status: 404 }),
    );
    mocks.githubApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }),
    );

    const response = await handleNotesAllGet(getContext());

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: 'not_found' });
  });
});

describe('GET /api/notes/:owner/:repo/all（R2 キャッシュ: M3）', () => {
  it('初期同期済み Vault は R2 上の全ノートを返す（GitHub API を消費しない）', async () => {
    const bucket = createFakeR2Bucket();
    await writeVaultMeta(bucket, 'octocat', 'notes', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-1',
    });
    await writeCachedNote(bucket, 'octocat', 'notes', 'README.md', {
      sha: 'sha-readme',
      content: '# README\n',
    });
    await writeCachedNote(bucket, 'octocat', 'notes', 'daily/2026-08-13.md', {
      sha: 'sha-daily',
      content: '# daily\n',
    });

    const response = await handleNotesAllGet(getContext(bucket));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      defaultBranch: 'main',
      truncated: false,
      notes: [
        { path: 'README.md', sha: 'sha-readme', content: '# README\n' },
        { path: 'daily/2026-08-13.md', sha: 'sha-daily', content: '# daily\n' },
      ],
    });
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('メタなし（未同期）Vault は GitHub から取得して R2 には書き込まない', async () => {
    const bucket = createFakeR2Bucket();
    mockGithubApi({ 'README.md': '# README\n' });

    const response = await handleNotesAllGet(getContext(bucket));
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.notes).toEqual([{ path: 'README.md', sha: 'sha-0', content: '# README\n' }]);
    const { listCachedNotes } = await import('@/api/_lib/r2-vault');
    expect(await listCachedNotes(bucket, 'octocat', 'notes')).toEqual([]);
  });
});
