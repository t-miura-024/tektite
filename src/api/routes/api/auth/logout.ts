/**
 * ログアウト: POST /api/auth/logout
 *
 * ステートレス認証（ADR-0002）のため、ログアウトはセッション Cookie の削除のみ。
 * サーバー側に破棄するセッション記録は存在しない。
 */

import { createRoute } from 'honox/factory';

import { clearSessionCookie } from '@/api/_lib/session';

export async function handleLogoutPost(): Promise<Response> {
  const headers = new Headers();
  headers.append('Set-Cookie', clearSessionCookie());
  return Response.json({ ok: true }, { headers });
}

export const POST = createRoute(() => handleLogoutPost());
