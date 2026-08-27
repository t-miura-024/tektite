/**
 * セッション状態確認: GET /api/auth/me。
 *
 * 暗号化セッション Cookie を復号し、GitHub /user でトークンの有効性を確認する
 * （ADR-0002）。トークンが無効化されていた場合はセッション Cookie を破棄して
 * 未ログイン扱いにする。PAT モード（ローカル専用フォールバック）では
 * セッション Cookie を読まず常に PAT を使う。
 */

import { createRoute } from 'honox/factory';

import { toRouteContext, type RouteContext } from '@/api/_lib/route-context';
import { isPatModeEnabled } from '@/api/_lib/github-proxy';
import { isAuthConfigError, resolveAuthConfig } from '@/api/_lib/env';
import { clearSessionCookie, readAccessToken } from '@/api/_lib/session';

/** API 呼び出しに使う認証情報（PAT モードは OAuth 変数を必要としない） */
type MeCredentials = {
  readonly apiBaseUrl: string;
  readonly accessToken: string | null;
};

/**
 * 認証情報を解決する。設定不備（OAuth 変数未設定）は未ログイン扱いの
 * 401 応答として返す。
 */
async function resolveCredentials(env: Env, request: Request): Promise<MeCredentials | Response> {
  if (isPatModeEnabled(env)) {
    return {
      apiBaseUrl: env.GITHUB_API_BASE_URL ?? 'https://api.github.com',
      accessToken: env.GITHUB_PERSONAL_TOKEN ?? null,
    };
  }
  let config;
  try {
    config = resolveAuthConfig(env);
  } catch (error) {
    if (isAuthConfigError(error)) {
      // 未設定ではセッションを復号できないため未ログイン扱いにする
      // （ログイン操作時に auth_not_configured エラーが表面化する）
      return Response.json({ authenticated: false }, { status: 401 });
    }
    throw error;
  }
  return {
    apiBaseUrl: config.apiBaseUrl,
    accessToken: await readAccessToken(request, config.sessionSecret),
  };
}

/** GitHub /user の応答からログイン名を読む（形式不正は null） */
function readLogin(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'login' in body) {
    const login = body.login;
    return typeof login === 'string' && login.length > 0 ? login : null;
  }
  return null;
}

export async function handleMeGet(context: RouteContext): Promise<Response> {
  const { env, request } = context;
  const credentials = await resolveCredentials(env, request);
  if (credentials instanceof Response) {
    return credentials;
  }
  const { apiBaseUrl, accessToken } = credentials;

  if (!accessToken) {
    return Response.json({ authenticated: false }, { status: 401 });
  }

  let userResponse: Response;
  try {
    userResponse = await fetch(`${apiBaseUrl}/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'tektite',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch {
    return Response.json({ error: 'github_unreachable' }, { status: 502 });
  }

  if (userResponse.status === 401) {
    // トークンが無効化されているためセッションも破棄する
    const headers = new Headers();
    headers.append('Set-Cookie', clearSessionCookie());
    return Response.json({ authenticated: false }, { status: 401, headers });
  }
  if (!userResponse.ok) {
    return Response.json({ error: 'github_error' }, { status: 502 });
  }

  const login = readLogin(await userResponse.json().catch(() => null));
  if (login === null) {
    return Response.json({ error: 'github_error' }, { status: 502 });
  }

  return Response.json(
    { authenticated: true, login },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export const GET = createRoute((c) => handleMeGet(toRouteContext(c.env, c.req.raw, c.req.param())));
