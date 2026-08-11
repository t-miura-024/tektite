/**
 * セッション検証: GET /api/auth/me
 *
 * UI がログイン状態を確認するエンドポイント。
 * OAuth モードでは暗号化 Cookie を復号し、トークンで GitHub /user を確認してログイン名を返す。
 * PAT モード（TEKTITE_PAT_AUTH=true かつ GITHUB_PERSONAL_TOKEN 設定）では OAuth 変数が
 * 不要なまま /user を PAT で呼び、ログイン済みとして返す（PAT 優先、Cookie は無視）。
 *
 * - 未ログイン / Cookie 復号失敗        → 401 { authenticated: false }
 * - トークン失効（GitHub が 401）        → Cookie を削除して 401
 * - GitHub API 障害                      → 502（UI はトースト + リトライ）
 * - 正常                                 → 200 { authenticated: true, login }
 */

import { isPatModeEnabled } from '@functions/api/_lib/github-proxy';
import { AuthConfigError, resolveAuthConfig } from '@functions/api/auth/_lib/env';
import { clearSessionCookie, readAccessToken } from '@functions/api/auth/_lib/session';

interface GitHubUserResponseBody {
  login?: string;
}

export const onRequestGet: PagesFunction<Env, 'api/auth/me'> = async ({ env, request }) => {
  // PAT モードは OAuth 変数を必要としない（PAT 優先: セッション Cookie は無視）
  let apiBaseUrl: string;
  let accessToken: string | null;
  if (isPatModeEnabled(env)) {
    apiBaseUrl = env.GITHUB_API_BASE_URL ?? 'https://api.github.com';
    accessToken = env.GITHUB_PERSONAL_TOKEN ?? null;
  } else {
    let config;
    try {
      config = resolveAuthConfig(env);
    } catch (error) {
      if (error instanceof AuthConfigError) {
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

  const user = (await userResponse.json().catch(() => null)) as GitHubUserResponseBody | null;
  if (!user || typeof user.login !== 'string' || user.login.length === 0) {
    return Response.json({ error: 'github_error' }, { status: 502 });
  }

  return Response.json(
    { authenticated: true, login: user.login },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};
