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

export async function handleMeGet(context: RouteContext): Promise<Response> {
  const { env, request } = context;
  const _isPat = isPatModeEnabled(env);
  let apiBaseUrl = '';
  let accessToken: string | null = null;
  if (_isPat) {
    apiBaseUrl = env.GITHUB_API_BASE_URL ?? 'https://api.github.com';
    accessToken = env.GITHUB_PERSONAL_TOKEN ?? null;
  }
  if (!_isPat) {
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
    apiBaseUrl = config.apiBaseUrl;
    accessToken = await readAccessToken(request, config.sessionSecret);
  }

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

  const _loginBody: unknown = await userResponse.json().catch(() => null);
  let login: string | null = null;
  if (typeof _loginBody === 'object' && _loginBody !== null && 'login' in _loginBody) {
    const _candidateLogin = _loginBody.login;
    if (typeof _candidateLogin === 'string' && _candidateLogin.length > 0) {
      login = _candidateLogin;
    }
  }
  if (login === null) {
    return Response.json({ error: 'github_error' }, { status: 502 });
  }

  return Response.json(
    { authenticated: true, login },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export const GET = createRoute((c) => handleMeGet(toRouteContext(c.env, c.req.raw, c.req.param())));
