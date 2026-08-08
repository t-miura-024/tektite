/**
 * ログイン開始: GET /api/auth/login
 *
 * CSRF 対策の state を署名付き Cookie に保存し、GitHub の認可ページへ
 * 302 リダイレクトする（OAuth App フロー、scope=repo）。
 */

import { generateOAuthState } from '../../../src/infra/auth/oauth-state';
import { AuthConfigError, GITHUB_AUTHORIZE_URL, resolveAuthConfig } from './_lib/env';
import { createStateCookie } from './_lib/session';

export const onRequestGet: PagesFunction<Env, 'api/auth/login'> = async ({ env }) => {
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

  const state = generateOAuthState();
  const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', config.clientId);
  authorizeUrl.searchParams.set('redirect_uri', config.redirectUri);
  authorizeUrl.searchParams.set('scope', 'repo');
  authorizeUrl.searchParams.set('state', state);

  const headers = new Headers();
  headers.set('Location', authorizeUrl.toString());
  headers.append('Set-Cookie', await createStateCookie(config.sessionSecret, state));
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
};
