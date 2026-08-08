/**
 * ノート取得/保存エンドポイント（GET|PUT /api/notes/:owner/:repo/blob/:path）の
 * ユニットテスト。
 *
 * 実ネットワークを使わず、GitHub プロキシ基盤（github-proxy）の githubApiFetch /
 * mapGithubFailure をモックして、ボディ検証と 409（sha 楽観ロック競合）→
 * conflict 変換、正常系の応答整形を検証する。
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
import { onRequestGet, onRequestPut } from './[path]';

const ENV = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  GITHUB_API_BASE_URL: 'http://mock.invalid',
} as unknown as Env;

const PARAMS = { owner: 'octocat', repo: 'notes', path: 'daily%2F2026-08-08.md' };

/** ASCII 本文を base64 にエンコードする（テストデータは ASCII のみ） */
function toBase64(text: string): string {
  return btoa(text);
}

/** PUT ハンドラの実行コンテキスト（部分オブジェクトを Pages 型に合わせる） */
function putContext(
  request: Request,
  params: Record<string, string | string[]> = PARAMS,
): Parameters<typeof onRequestPut>[0] {
  return { env: ENV, request, params } as unknown as Parameters<typeof onRequestPut>[0];
}

function getContext(
  request: Request,
  params: Record<string, string | string[]> = PARAMS,
): Parameters<typeof onRequestGet>[0] {
  return { env: ENV, request, params } as unknown as Parameters<typeof onRequestGet>[0];
}

/** base64 エンコード済みの PUT ボディを持つリクエストを作る */
function putRequest(body: unknown): Request {
  return new Request('http://localhost/api/notes/octocat/notes/blob/daily%2F2026-08-08.md', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

function okAuth() {
  mocks.authenticateRequest.mockResolvedValue({ ok: true, token: 'token' });
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
  okAuth();
});

describe('PUT /api/notes/:owner/:repo/blob/:path', () => {
  it('有効なボディで Contents API に PUT を転送し、保存後の sha を返す', async () => {
    mocks.githubApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ content: { sha: 'sha-after-save' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await onRequestPut(
      putContext(
        putRequest({
          content: toBase64('# saved\n'),
          sha: 'sha-read',
          message: 'Update 2026-08-08.md',
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      owner: 'octocat',
      name: 'notes',
      path: 'daily/2026-08-08.md',
      sha: 'sha-after-save',
    });
    expect(mocks.githubApiFetch).toHaveBeenCalledWith(
      'http://mock.invalid',
      '/repos/octocat/notes/contents/daily/2026-08-08.md',
      'token',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('sha なしのボディ（新規作成）では sha を転送しない', async () => {
    mocks.githubApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ content: { sha: 'sha-new' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await onRequestPut(
      putContext(
        putRequest({
          content: toBase64('# new\n'),
          message: 'Create new-note.md',
        }),
        { ...PARAMS, path: 'new-note.md' },
      ),
    );

    expect(response.status).toBe(200);
    const sentBody = JSON.parse(String(mocks.githubApiFetch.mock.calls[0]?.[3]?.body));
    expect(sentBody).toEqual({ content: expect.any(String), message: 'Create new-note.md' });
    expect(sentBody.sha).toBeUndefined();
  });

  it('GitHub の 409 は error: conflict の 409 としてそのまま伝える', async () => {
    mocks.githubApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ message: 'sha does not match current blob sha' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await onRequestPut(
      putContext(
        putRequest({
          content: toBase64('# saved\n'),
          sha: 'sha-stale',
          message: 'Update 2026-08-08.md',
        }),
      ),
    );

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      error: 'conflict',
      message: 'sha does not match current blob sha',
    });
    // 409 は mapGithubFailure（502 化）を通さずに処理する
    expect(mocks.mapGithubFailure).not.toHaveBeenCalled();
  });

  it('不正なボディ（base64 でない content）は 400 invalid_note_body', async () => {
    const response = await onRequestPut(
      putContext(putRequest({ content: 'not base64!', sha: 'sha', message: 'Update' })),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: 'invalid_note_body' });
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  it('ボディ欠落（content / message なし）は 400 invalid_note_body', async () => {
    const missingContent = await onRequestPut(
      putContext(putRequest({ sha: 'sha', message: 'Update' })),
    );
    expect(missingContent.status).toBe(400);

    const missingMessage = await onRequestPut(
      putContext(putRequest({ content: toBase64('# x\n') })),
    );
    expect(missingMessage.status).toBe(400);
  });

  it('未認証は 401 を返し、GitHub API を呼ばない', async () => {
    mocks.authenticateRequest.mockResolvedValue({
      ok: false,
      response: Response.json({ error: 'unauthenticated' }, { status: 401 }),
    });

    const response = await onRequestPut(
      putContext(putRequest({ content: toBase64('# saved\n'), message: 'Update 2026-08-08.md' })),
    );

    expect(response.status).toBe(401);
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });
});

describe('パラメータ検証（GET / PUT 共通）', () => {
  it('不正な owner / repo は 400 invalid_vault_ref', async () => {
    const response = await onRequestPut(
      putContext(putRequest({ content: toBase64('# x\n'), message: 'm' }), {
        ...PARAMS,
        owner: 'bad owner!',
      }),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: 'invalid_vault_ref' });
  });

  it('空のパスは 400 invalid_note_path', async () => {
    const response = await onRequestPut(
      putContext(putRequest({ content: toBase64('# x\n'), message: 'm' }), {
        ...PARAMS,
        path: '',
      }),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: 'invalid_note_path' });
  });

  it('パスセグメントのパーセントエンコードは GET 応答の path で復元される', async () => {
    mocks.githubApiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'file',
          encoding: 'base64',
          content: toBase64('# daily\n'),
          sha: 'sha-daily',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await onRequestGet(
      getContext(
        new Request('http://localhost/api/notes/octocat/notes/blob/daily%2F2026-08-08.md'),
      ),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(
      expect.objectContaining({ path: 'daily/2026-08-08.md', content: '# daily\n' }),
    );
  });
});
