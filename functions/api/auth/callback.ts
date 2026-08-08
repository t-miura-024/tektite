/**
 * OAuth コールバック: GET /api/auth/callback
 *
 * 1. state の検証（署名付き Cookie との突き合わせ、CSRF 対策）
 * 2. authorization code をアクセストークンに交換（server-side のみ）
 * 3. トークンを AES-GCM 暗号化して HttpOnly Cookie に格納（ADR-0002）
 * 4. SPA ルートへリダイレクト（失敗時は ?error=<code> を付与）
 */

import { AuthConfigError, resolveAuthConfig } from './_lib/env';
import { clearStateCookie, createSessionCookie, verifyStateCookie } from './_lib/session';

interface TokenResponseBody {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** エラーコードを付与して SPA ルートへ戻す（state Cookie も破棄する） */
function redirectToApp(errorCode: string): Response {
  const headers = new Headers();
  headers.set('Location', `/?error=${errorCode}`);
  headers.append('Set-Cookie', clearStateCookie());
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
}

export const onRequestGet: PagesFunction<Env, 'api/auth/callback'> = async ({ env, request }) => {
  let config;
  try {
    config = resolveAuthConfig(env);
  } catch (error) {
    if (error instanceof AuthConfigError) {
      return Response.json(
        { error: 'auth_not_configured', message: error.message },
        { status: 500 },
      );
    }
    throw error;
  }

  const url = new URL(request.url);

  // GitHub 側でユーザーが認可を拒否した場合など
  if (url.searchParams.get('error')) {
    return redirectToApp('oauth_denied');
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return redirectToApp('oauth_state');
  }
  if (!(await verifyStateCookie(request, config.sessionSecret, state))) {
    return redirectToApp('oauth_state');
  }

  // トークン交換は Workers 側のみ（ブラウザに client_secret / トークンは出さない）。
  // GitHub は Accept を付けないと XML を返すため application/json を明示する。
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'tektite',
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
        state,
      }),
    });
  } catch {
    return redirectToApp('oauth_exchange');
  }

  // GitHub はトークン交換のエラーを 200 + { error } で返すことがある
  const tokenBody = (await tokenResponse.json().catch(() => null)) as TokenResponseBody | null;
  if (!tokenResponse.ok || !tokenBody || typeof tokenBody.access_token !== 'string') {
    const errorCode =
      tokenBody?.error === 'bad_verification_code' ? 'oauth_exchange' : 'oauth_denied';
    return redirectToApp(errorCode);
  }

  const headers = new Headers();
  headers.set('Location', '/');
  headers.append(
    'Set-Cookie',
    await createSessionCookie(config.sessionSecret, tokenBody.access_token),
  );
  headers.append('Set-Cookie', clearStateCookie());
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
};
