/**
 * ログアウト: POST /api/auth/logout
 *
 * ステートレス認証（ADR-0002）のため、ログアウトはセッション Cookie の削除のみ。
 * サーバー側に破棄するセッション記録は存在しない。
 */

import { clearSessionCookie } from '@functions/api/auth/_lib/session';

export const onRequestPost: PagesFunction<Env, 'api/auth/logout'> = () => {
  const headers = new Headers();
  headers.append('Set-Cookie', clearSessionCookie());
  return Response.json({ ok: true }, { headers });
};
