/**
 * セッション系ユースケース（M2: 認証とセッション）。
 *
 * ログイン状態の確認とログアウトを進行させる。セッションの実体は
 * 暗号化 Cookie（ADR-0002）であり、この層はポート（SessionGateway）経由で
 * だけ永続化に触れる。実装は src/infra/auth（Pages Functions プロキシ呼び出し）。
 *
 * 依存性逆転の仕組みとして Effect の Service（Tag）を採用する:
 * ポートはこの層で Effect Service として定義し、具体実装（Layer）は src/infra が、
 * 組成（Layer の組み立てと実行）は src/composition が担う。UI 層は infra を
 * import しない（.oxlintrc.json で機械的に検査される）。
 */

import { Context, Effect } from 'effect';

/** ログイン中の GitHub ユーザー */
export interface SessionUser {
  readonly login: string;
}

/** 現在のセッション状態 */
export type Session =
  | { readonly status: 'anonymous' }
  | { readonly status: 'authenticated'; readonly user: SessionUser };

/** セッション確認/ログアウトの通信で発生するエラー */
export class SessionFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SessionFetchError';
  }
}

/**
 * ポート: セッションの照会と破棄（Effect Service）。
 * src/infra/auth の SessionGatewayLive（Pages Functions 経由）が実装する。
 */
export interface SessionGateway {
  readonly getCurrentSession: () => Effect.Effect<Session, SessionFetchError>;
  readonly logout: () => Effect.Effect<void, SessionFetchError>;
}
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
