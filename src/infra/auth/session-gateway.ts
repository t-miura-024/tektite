/**
 * SessionGateway のブラウザ実装（Effect Layer）:
 * Pages Functions の認証エンドポイントを呼ぶ。
 *
 * - GET  /api/auth/me     … セッション検証（暗号化 Cookie の復号 + GitHub /user 確認）
 * - POST /api/auth/logout … セッション Cookie の削除
 *
 * トークンは Workers 側のみ保持（ADR-0002）のため、ブラウザは Cookie の存在を
 * 直接読むことなく、これらのエンドポイントの応答だけでログイン状態を判定する。
 *
 * application 層が定義する SessionGateway（Effect Service）の具体実装を
 * Layer として提供する。組成（UI への注入）は src/composition が担う。
 */

import { Effect, Layer } from 'effect';

import { sessionFetchError, SessionGateway, type Session } from '@/application/session';

/** /api/auth/me 応答から認証済みフラグを読む（形式不正は false） */
function readAuthenticated(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'authenticated' in body
    ? body.authenticated === true
    : false;
}

/** /api/auth/me 応答からログイン名を読む（形式不正は null） */
function readLogin(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'login' in body) {
    const login = body.login;
    return typeof login === 'string' && login.length > 0 ? login : null;
  }
  return null;
}

function toSession(body: unknown): Session {
  if (readAuthenticated(body)) {
    const login = readLogin(body);
    if (login !== null) {
      return { status: 'authenticated', user: { login } };
    }
  }
  return { status: 'anonymous' };
}

/** SessionGateway の本番実装（Pages Functions 経由） */
export const SessionGatewayLive = Layer.succeed(SessionGateway, {
  getCurrentSession: () =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () => fetch('/api/auth/me'),
        catch: (error) =>
          sessionFetchError('セッション状態を確認できませんでした。', { cause: error }),
      });
      if (response.status === 401) {
        return { status: 'anonymous' } as const;
      }
      if (!response.ok) {
        return yield* Effect.fail(
          sessionFetchError(`セッション確認に失敗しました（HTTP ${response.status}）。`),
        );
      }
      const body = yield* Effect.tryPromise({
        try: (): Promise<unknown> => response.json(),
        catch: (error) =>
          sessionFetchError('セッション状態を確認できませんでした。', { cause: error }),
      });
      return toSession(body);
    }),

  logout: () =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () => fetch('/api/auth/logout', { method: 'POST' }),
        catch: (error) => sessionFetchError('ログアウトできませんでした。', { cause: error }),
      });
      if (!response.ok) {
        return yield* Effect.fail(
          sessionFetchError(`ログアウトに失敗しました（HTTP ${response.status}）。`),
        );
      }
    }),
});
