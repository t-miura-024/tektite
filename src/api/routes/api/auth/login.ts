/**
 * ログイン開始: GET /api/auth/login
 *
 * CSRF 対策の state を署名付き Cookie に保存し、GitHub の認可ページへ
 * 302 リダイレクトする（OAuth App フロー、scope=repo）。
 *
 * `?return_to=<path>` が指定された場合は、ログイン後の戻り先を署名付き
 * Cookie に保存する（ディープリンク復帰。コールバックで検証してリダイレクト）。
 */

import { createRoute } from 'honox/factory';

import type { RouteContext } from '@/api/_lib/route-context';
import { generateOAuthState } from '@/infra/auth/oauth-state';
import { AuthConfigError, GITHUB_AUTHORIZE_URL, resolveAuthConfig } from '@/api/_lib/env';
import { createStateCookie, createReturnToCookie, isSafeReturnTo } from '@/api/_lib/session';

export async function handleLoginGet(context: RouteContext): Promise<Response> {
  const { env, request } = context;
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

  // ディープリンクからのログイン: 安全な同一オリジンパスのみ return-to として保持する
  const returnTo = new URL(request.url).searchParams.get('return_to');
  if (returnTo !== null && isSafeReturnTo(returnTo)) {
    headers.append('Set-Cookie', await createReturnToCookie(config.sessionSecret, returnTo));
  }

  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
}

export const GET = createRoute((c) =>
  handleLoginGet({ env: c.env as Env, request: c.req.raw, params: c.req.param() }),
);
