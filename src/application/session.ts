/**
 * セッション系ユースケース（M2: 認証とセッション）。
 *
 * ログイン状態の確認とログアウトを進行させる。セッションの実体は
 * 暗号化 Cookie（ADR-0002）であり、この層はポート（SessionGateway）経由で
 * だけ永続化に触れる。実装は src/infra/auth（Pages Functions プロキシ呼び出し）。
 */

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
 * ポート: セッションの照会と破棄。
 * src/infra/auth の HttpSessionGateway が Pages Functions 経由で実装する。
 */
export interface SessionGateway {
  getCurrentSession(): Promise<Session>;
  logout(): Promise<void>;
}

/**
 * セッション系ユースケースをまとめる。
 * UI 層はこれを通じてのみセッション状態を操作する。
 */
export class SessionUseCases {
  constructor(private readonly gateway: SessionGateway) {}

  /** 現在のセッション状態を確認する（未ログインは anonymous、障害は SessionFetchError） */
  getCurrentSession(): Promise<Session> {
    return this.gateway.getCurrentSession();
  }

  /** ログアウトし、セッション Cookie を破棄する */
  async logout(): Promise<void> {
    await this.gateway.logout();
  }
}
