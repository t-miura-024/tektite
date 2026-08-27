/**
 * OAuth コールバック: GET /api/auth/callback
 *
 * 1. state の検証（署名付き Cookie との突き合わせ、CSRF 対策）
 * 2. authorization code をアクセストークンに交換（server-side のみ）
 * 3. トークンを AES-GCM 暗号化して HttpOnly Cookie に格納（ADR-0002）
 * 4. トークンペアを KV に暗号化保存（ADR-0007。write 権限を保存時に確認し、
 *    以降の Cron 同期では Cookie なしで GitHub アクセスできるようにする）
 * 5. ログイン前の return-to（署名付き Cookie、既定は SPA ルート）へリダイレクト
 *    （失敗時は ?error=<code> を付与して SPA ルートへ）
 *
 * KV 保存はベストエフォート: 失敗・KV 未設定・write 権限なしでも
 * ログイン（Cookie フロー）は継続し、既存挙動を壊さない。
 */

import { createRoute } from 'honox/factory';

import { toRouteContext, type RouteContext } from '@/api/_lib/route-context';
import { isAuthConfigError, resolveAuthConfig } from '@/api/_lib/env';
import { persistOAuthTokenPair } from '@/api/_lib/token-store';
import {
  clearReturnToCookie,
  clearStateCookie,
  createSessionCookie,
  verifyReturnToCookie,
  verifyStateCookie,
} from '@/api/_lib/session';
import {
  exchangeCodeForToken,
  extractTokenFields,
  parseTokenBody,
} from '@/api/_lib/callback-helpers';

/** エラーコードを付与して SPA ルートへ戻す（state / return-to Cookie も破棄する） */
function redirectToApp(errorCode: string): Response {
  const headers = new Headers();
  headers.set('Location', `/?error=${errorCode}`);
  headers.append('Set-Cookie', clearStateCookie());
  headers.append('Set-Cookie', clearReturnToCookie());
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
}

export async function handleCallbackGet(context: RouteContext): Promise<Response> {
  const { env, request } = context;
  let config;
  try {
    config = resolveAuthConfig(env);
  } catch (error) {
    if (isAuthConfigError(error)) {
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

  const tokenResponse = await exchangeCodeForToken(
    config.tokenUrl,
    config.clientId,
    config.clientSecret,
    code,
    config.redirectUri,
    state,
  );
  if (tokenResponse === null) {
    return redirectToApp('oauth_exchange');
  }
  const tokenBody: unknown = await tokenResponse.json().catch(() => null);
  const { accessToken, errorCode } = parseTokenBody(tokenBody);
  if (!tokenResponse.ok || typeof accessToken !== 'string') {
    return redirectToApp(errorCode === 'bad_verification_code' ? 'oauth_exchange' : 'oauth_denied');
  }
  const tokenFields = extractTokenFields(tokenBody, accessToken);

  const headers = new Headers();
  // ディープリンク復帰: 署名検証済みの return-to（未指定・不正時は "/"）へ戻す
  headers.set('Location', await verifyReturnToCookie(request, config.sessionSecret));
  headers.append(
    'Set-Cookie',
    await createSessionCookie(config.sessionSecret, tokenFields.access_token ?? accessToken),
  );
  headers.append('Set-Cookie', clearStateCookie());
  headers.append('Set-Cookie', clearReturnToCookie());
  headers.set('Cache-Control', 'no-store');

  // サーバー側トークン保持（ADR-0007）: KV へ暗号化保存。失敗しても
  // ログインは妨げない（Cron 同期が動かないだけで、Cookie フローは従来通り）
  try {
    await persistOAuthTokenPair(env, config, tokenFields);
  } catch (error) {
    // oxlint-disable-next-line no-console -- KV 保存失敗の観測性のため維持（ベストエフォート）
    console.warn('[tektite] KV へのトークン保存をスキップしました:', error);
  }

  return new Response(null, { status: 302, headers });
}

export const GET = createRoute((c) =>
  handleCallbackGet(toRouteContext(c.env, c.req.raw, c.req.param())),
);
