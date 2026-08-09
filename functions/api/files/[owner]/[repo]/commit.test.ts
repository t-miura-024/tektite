/**
 * 一括コミットエンドポイント（POST /api/files/:owner/:repo/commit）のユニットテスト。
 *
 * 実ネットワークを使わず、GitHub プロキシ基盤（github-proxy）をモックして、
 * Git Trees/Blobs API の呼び出し順序・リクエストボディ・単一コミットの成立
 * （ref 更新まで 1 回）・エラー変換（ボディ不正 / move 元不在 / ref 競合）を検証する。
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

import { onRequestPost } from './commit';
import { ProxyConfigError as MockedProxyConfigError } from '@functions/api/_lib/github-proxy';

const ENV = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  GITHUB_API_BASE_URL: 'http://mock.invalid',
} as unknown as Env;

const PARAMS = { owner: 'octocat', repo: 'notes' };

function postContext(
  request: Request,
  params: Record<string, string | string[]> = PARAMS,
): Parameters<typeof onRequestPost>[0] {
  return { env: ENV, request, params } as unknown as Parameters<typeof onRequestPost>[0];
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/files/octocat/notes/commit', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** モックの GitHub API 応答を組み立てる */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 正常系の GitHub API 応答シーケンス（呼び出し順に応答を返す） */
function mockGitHubSequence(
  overrides: {
    refStatus?: number;
    updateRefStatus?: number;
    moveSourceMissing?: boolean;
    /** 空リポジトリ（ref / trees が 404、refs PATCH も 404 → POST refs で作成） */
    emptyRepo?: boolean;
  } = {},
) {
  const treeEntries = overrides.moveSourceMissing
    ? []
    : [
        { path: 'a.md', type: 'blob', sha: 'sha-a' },
        { path: 'b.md', type: 'blob', sha: 'sha-b' },
      ];
  mocks.githubApiFetch.mockImplementation(
    (_base: string, path: string, _token: string, init?: unknown) => {
      const method = (init as { method?: string } | undefined)?.method ?? 'GET';
      if (path === '/repos/octocat/notes') {
        return Promise.resolve(jsonResponse({ default_branch: 'main' }));
      }
      // GET は /git/ref/（単数）、PATCH は /git/refs/（複数）が GitHub API の規約
      if (path === '/repos/octocat/notes/git/ref/heads/main') {
        if (overrides.emptyRepo || overrides.refStatus === 404) {
          return Promise.resolve(jsonResponse({ message: 'Not Found' }, 404));
        }
        return Promise.resolve(
          jsonResponse({ ref: 'refs/heads/main', object: { sha: 'commit-head' } }),
        );
      }
      if (path === '/repos/octocat/notes/git/refs/heads/main') {
        if (overrides.emptyRepo) {
          // 初回コミット前は ref が存在しない（PATCH は 404）
          return Promise.resolve(jsonResponse({ message: 'Not Found' }, 404));
        }
        if (overrides.updateRefStatus === 409) {
          return Promise.resolve(
            jsonResponse({ message: 'reference is not fast-forwardable' }, 409),
          );
        }
        return Promise.resolve(
          jsonResponse({ ref: 'refs/heads/main', object: { sha: 'commit-new' } }),
        );
      }
      if (path === '/repos/octocat/notes/git/refs') {
        // 空リポジトリの初回コミットは POST でブランチ参照を作成する
        return Promise.resolve(
          jsonResponse({ ref: 'refs/heads/main', object: { sha: 'commit-new' } }, 201),
        );
      }
      if (
        path === '/repos/octocat/notes/git/trees' ||
        path.startsWith('/repos/octocat/notes/git/trees/')
      ) {
        if (method === 'POST') {
          return Promise.resolve(jsonResponse({ sha: 'tree-new', tree: [] }));
        }
        if (overrides.emptyRepo) {
          return Promise.resolve(jsonResponse({ message: 'Not Found' }, 404));
        }
        return Promise.resolve(
          jsonResponse({ sha: 'tree-base', truncated: false, tree: treeEntries }),
        );
      }
      if (path === '/repos/octocat/notes/git/blobs') {
        return Promise.resolve(
          jsonResponse({ sha: `blob-${Math.random().toString(36).slice(2)}` }),
        );
      }
      if (path === '/repos/octocat/notes/git/commits') {
        return Promise.resolve(jsonResponse({ sha: 'commit-new' }));
      }
      return Promise.resolve(jsonResponse({ message: `no mock for ${method} ${path}` }, 404));
    },
  );
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** モック呼び出しの JSON ボディを読む（対象呼び出しが無い場合はテストを失敗させる） */
function callBody(callIndex: number): Record<string, unknown> {
  const call = mocks.githubApiFetch.mock.calls[callIndex];
  if (call === undefined || typeof call[3] !== 'object' || call[3] === null) {
    throw new Error(`githubApiFetch call #${callIndex} がありません`);
  }
  return JSON.parse((call[3] as { body?: string }).body ?? '{}') as Record<string, unknown>;
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

describe('POST /api/files/:owner/:repo/commit', () => {
  it('create/update/delete を Trees/Blobs API で単一コミットにする', async () => {
    mockGitHubSequence();

    const response = await onRequestPost(
      postContext(
        postRequest({
          message: 'Rename b.md to notes/b.md',
          changes: [
            { op: 'move', path: 'b.md', to: 'notes/b.md' },
            { op: 'update', path: 'a.md', content: btoa('# A v2\n') },
            { op: 'delete', path: 'c.md' },
          ],
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      branch: 'main',
      commitSha: 'commit-new',
    });

    // 呼び出し: repo → ref → trees → blobs → trees(POST) → commits → refs(PATCH)
    const calls = mocks.githubApiFetch.mock.calls.map((call) => ({
      path: call[1],
      method: (call[3] as { method?: string } | undefined)?.method ?? 'GET',
    }));
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /repos/octocat/notes',
      'GET /repos/octocat/notes/git/ref/heads/main',
      'GET /repos/octocat/notes/git/trees/main?recursive=1',
      'POST /repos/octocat/notes/git/blobs',
      'POST /repos/octocat/notes/git/trees',
      'POST /repos/octocat/notes/git/commits',
      'PATCH /repos/octocat/notes/git/refs/heads/main',
    ]);

    // Blob は base64 のまま転送される
    expect(callBody(3)).toEqual({
      content: btoa('# A v2\n'),
      encoding: 'base64',
    });

    // 新 tree: base_tree 継承 + 差分エントリ（move は sha 再利用 + 元パス削除、
    // update は新 blob、delete は sha: null）
    const treeBody = callBody(4);
    const treeEntries = treeBody.tree as unknown as { path: string; sha: string | null }[];
    expect(treeBody.base_tree).toBe('tree-base');
    expect(treeEntries).toHaveLength(4);
    expect(treeEntries).toContainEqual({
      path: 'notes/b.md',
      mode: '100644',
      type: 'blob',
      sha: 'sha-b',
    });
    expect(treeEntries).toContainEqual({ path: 'b.md', mode: '100644', type: 'blob', sha: null });
    expect(treeEntries).toContainEqual({ path: 'c.md', mode: '100644', type: 'blob', sha: null });
    expect(treeEntries.some((entry) => entry.path === 'a.md')).toBe(true);

    // コミット: parents はブランチ先頭コミット
    expect(callBody(5)).toEqual({
      message: 'Rename b.md to notes/b.md',
      tree: 'tree-new',
      parents: ['commit-head'],
    });

    // ref 更新は force: false（非 fast-forward を検出するため）
    expect(callBody(6)).toEqual({
      sha: 'commit-new',
      force: false,
    });
  });

  it('move 後に同一パスへ update した場合は後続の update が勝つ', async () => {
    mockGitHubSequence();

    const response = await onRequestPost(
      postContext(
        postRequest({
          message: 'Rename a.md to notes/a.md',
          changes: [
            { op: 'move', path: 'a.md', to: 'notes/a.md' },
            { op: 'update', path: 'notes/a.md', content: btoa('# rewritten\n') },
          ],
        }),
      ),
    );

    expect(response.status).toBe(200);
    const treeBody = callBody(4);
    const entries = treeBody.tree as { path: string; sha: string | null }[];
    const target = entries.find((entry) => entry.path === 'notes/a.md');
    // move の sha 再利用を update の新 blob が上書きする（sha-a ではない）
    expect(target?.sha).not.toBe('sha-a');
    expect(entries).toContainEqual({ path: 'a.md', mode: '100644', type: 'blob', sha: null });
  });

  it('move 元が base tree にない場合は 400 invalid_change で中断する', async () => {
    mockGitHubSequence({ moveSourceMissing: true });

    const response = await onRequestPost(
      postContext(
        postRequest({
          message: 'Move missing.md',
          changes: [{ op: 'move', path: 'missing.md', to: 'elsewhere.md' }],
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      error: 'invalid_change',
      message: '移動元「missing.md」が見つかりません。',
    });
  });

  it('ref 更新の 409 は conflict として返す（楽観ロック競合）', async () => {
    mockGitHubSequence({ updateRefStatus: 409 });

    const response = await onRequestPost(
      postContext(
        postRequest({
          message: 'Create new.md',
          changes: [{ op: 'create', path: 'new.md', content: '' }],
        }),
      ),
    );

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({ error: 'conflict' });
  });

  it('空リポジトリの初回コミットは parents / base_tree 無しで作る（M2）', async () => {
    mockGitHubSequence({ emptyRepo: true });

    const response = await onRequestPost(
      postContext(
        postRequest({
          message: 'Create index.md',
          changes: [{ op: 'create', path: 'index.md', content: btoa('# first note\n') }],
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      branch: 'main',
      commitSha: 'commit-new',
    });

    // 呼び出し: repo → ref(404) → trees(404) → blobs → trees(POST) → commits → refs(PATCH 404) → refs(POST)
    const calls = mocks.githubApiFetch.mock.calls.map((call) => ({
      path: call[1],
      method: (call[3] as { method?: string } | undefined)?.method ?? 'GET',
    }));
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /repos/octocat/notes',
      'GET /repos/octocat/notes/git/ref/heads/main',
      'GET /repos/octocat/notes/git/trees/main?recursive=1',
      'POST /repos/octocat/notes/git/blobs',
      'POST /repos/octocat/notes/git/trees',
      'POST /repos/octocat/notes/git/commits',
      'PATCH /repos/octocat/notes/git/refs/heads/main',
      'POST /repos/octocat/notes/git/refs',
    ]);

    // 新 tree は base_tree を省略する（既存ツリーが無いため）
    const treeBody = callBody(4);
    expect(treeBody.base_tree).toBeUndefined();

    // コミットは parents 無し（ルートコミット）
    expect(callBody(5)).toEqual({
      message: 'Create index.md',
      tree: 'tree-new',
      parents: [],
    });

    // ref は POST /git/refs で新規作成する（refs/heads/main）
    expect(callBody(7)).toEqual({ ref: 'refs/heads/main', sha: 'commit-new' });
  });

  it('ボディ不正（未知の op / 不正パス / base64 でない content）は 400', async () => {
    const cases: unknown[] = [
      { message: 'x', changes: [{ op: 'copy', path: 'a.md', content: '' }] },
      { message: 'x', changes: [{ op: 'create', path: '../a.md', content: '' }] },
      { message: 'x', changes: [{ op: 'create', path: '/a.md', content: '' }] },
      { message: 'x', changes: [{ op: 'update', path: 'a.md', content: 'base64???' }] },
      { message: 'x', changes: [{ op: 'move', path: 'a.md', to: 'a.md' }] },
      { message: 'x', changes: [] },
      { message: '', changes: [{ op: 'create', path: 'a.md', content: '' }] },
    ];

    const results = await Promise.all(
      cases.map(async (body) => {
        const response = await onRequestPost(postContext(postRequest(body)));
        return { status: response.status, body: await readJson(response) };
      }),
    );
    for (const result of results) {
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: 'invalid_body' });
    }
  });

  it('未認証は 401、プロキシ未設定は 503 を返す', async () => {
    mocks.authenticateRequest.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 }),
    });
    const unauthorized = await onRequestPost(
      postContext(
        postRequest({ message: 'x', changes: [{ op: 'create', path: 'a.md', content: '' }] }),
      ),
    );
    expect(unauthorized.status).toBe(401);

    mocks.resolveProxyConfig.mockImplementation(() => {
      throw new MockedProxyConfigError('未設定');
    });
    const notConfigured = await onRequestPost(
      postContext(
        postRequest({ message: 'x', changes: [{ op: 'create', path: 'a.md', content: '' }] }),
      ),
    );
    expect(notConfigured.status).toBe(503);
  });

  it('GitHub の 429 は rate_limited として変換される', async () => {
    mockGitHubSequence();
    mocks.mapGithubFailure.mockReturnValue(
      new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }),
    );

    const response = await onRequestPost(
      postContext(
        postRequest({ message: 'x', changes: [{ op: 'create', path: 'a.md', content: '' }] }),
      ),
    );

    expect(response.status).toBe(429);
    expect(await readJson(response)).toEqual({ error: 'rate_limited' });
  });
});
