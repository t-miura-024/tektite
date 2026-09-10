/**
 * セッション系ユースケース（M2: 認証）。
 * 確認とログアウトを進める。永続化はSessionGateway経由のみ。
 * 実装はsrc/infra、組成はsrc/compositionが担う。
 */

import { Context, Effect } from 'effect';

import { makeNamedError, isErrorNamed } from '@/application/error-object';

/** ログイン中の GitHub ユーザー */
export type SessionUser = {
  readonly login: string;
};

/** 現在のセッション状態 */
export type Session =
  | { readonly status: 'anonymous' }
  | { readonly status: 'authenticated'; readonly user: SessionUser };

/** セッション確認/ログアウトの通信で発生するエラー */
export type SessionFetchError = Error;

/** SessionFetchError を生成するファクトリ */
export function sessionFetchError(
  message: string,
  options?: { cause?: unknown },
): SessionFetchError {
  return makeNamedError('SessionFetchError', message, options);
}

/** error が SessionFetchError かどうか */
export function isSessionFetchError(error: unknown): error is SessionFetchError {
  return isErrorNamed(error, 'SessionFetchError');
}

/**
 * ポート: セッションの照会と破棄（Effect Service）。
 * src/infra/auth の SessionGatewayLive（Pages Functions 経由）が実装する。
 */
export type SessionGateway = {
  readonly getCurrentSession: () => Effect.Effect<Session, SessionFetchError>;
  readonly logout: () => Effect.Effect<void, SessionFetchError>;
};
export const SessionGateway = Context.GenericTag<SessionGateway>('tektite/SessionGateway');

/** 現在のセッション状態を確認する（未ログインは anonymous、障害は SessionFetchError） */
export const getCurrentSession: Effect.Effect<Session, SessionFetchError, SessionGateway> =
  Effect.gen(function* () {
    const gateway = yield* SessionGateway;
    return yield* gateway.getCurrentSession();
  });

/** ログアウトし、セッション Cookie を破棄する */
export const logout: Effect.Effect<void, SessionFetchError, SessionGateway> = Effect.gen(
  function* () {
    const gateway = yield* SessionGateway;
    return yield* gateway.logout();
  },
);
