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

import { SessionFetchError, SessionGateway } from '@/application/session';
import type { Session } from '@/application/session';

interface MeResponseBody {
  authenticated?: boolean;
  login?: string;
}

function toSession(body: MeResponseBody): Session {
  if (body.authenticated === true && typeof body.login === 'string' && body.login.length > 0) {
    return { status: 'authenticated', user: { login: body.login } };
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
          new SessionFetchError('セッション状態を確認できませんでした。', { cause: error }),
      });
      if (response.status === 401) {
        return { status: 'anonymous' } as const;
      }
      if (!response.ok) {
        return yield* Effect.fail(
          new SessionFetchError(`セッション確認に失敗しました（HTTP ${response.status}）。`),
        );
      }
      const body = yield* Effect.tryPromise({
        try: () => response.json() as Promise<MeResponseBody>,
        catch: (error) =>
          new SessionFetchError('セッション状態を確認できませんでした。', { cause: error }),
      });
      return toSession(body);
    }),

  logout: () =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () => fetch('/api/auth/logout', { method: 'POST' }),
        catch: (error) => new SessionFetchError('ログアウトできませんでした。', { cause: error }),
      });
      if (!response.ok) {
        return yield* Effect.fail(
          new SessionFetchError(`ログアウトに失敗しました（HTTP ${response.status}）。`),
        );
      }
    }),
});
