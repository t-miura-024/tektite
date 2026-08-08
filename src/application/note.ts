/**
 * ノート系ユースケース（M1: ノート読み込みと CM6 エディタ基盤）。
 *
 * ノート（Markdown ファイル）の本文と sha を取得する。sha は保存時の
 * 楽観ロック（M3）に使うため、本文と常にセットで返す。
 * GitHub API には直接触れず、ポート（NoteGateway）経由でだけ通信する。
 * 実装は src/infra/github（Pages Functions プロキシ呼び出し）。
 *
 * ポートは Effect Service（Tag）として定義し、具体実装（Layer）は src/infra が、
 * 組成は src/composition が担う（src/application/session.ts と同じ仕組み）。
 */

import { Context, Effect } from 'effect';

import type { VaultRef } from '@/domain/vault';

/** ノート取得エラーの種類（UI がメッセージとリトライ導線を選ぶ材料） */
export type NoteFetchErrorKind =
  | 'unauthenticated'
  | 'rate_limited'
  | 'not_found'
  | 'server'
  | 'network';

/** ノート取得の通信で発生するエラー */
export class NoteFetchError extends Error {
  readonly kind: NoteFetchErrorKind;

  constructor(kind: NoteFetchErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NoteFetchError';
    this.kind = kind;
  }
}

/** ノート取得の結果（本文 + 楽観ロック用 sha） */
export interface NoteContent {
  /** Vault ルートからのノートパス（/ 区切り） */
  readonly path: string;
  /** GitHub 上のファイル sha（保存時の楽観ロックに使う） */
  readonly sha: string;
  /** ノート本文（UTF-8 のテキスト） */
  readonly content: string;
}

/**
 * ポート: ノート本文と sha の取得（Effect Service）。
 * src/infra/github の NoteGatewayLive（Pages Functions 経由）が実装する。
 */
export interface NoteGateway {
  readonly fetchNote: (
    ref: VaultRef,
    notePath: string,
  ) => Effect.Effect<NoteContent, NoteFetchError>;
}
export const NoteGateway = Context.GenericTag<NoteGateway>('tektite/NoteGateway');

/** ノートを開き、本文と sha を取得する */
export const openNote = (
  ref: VaultRef,
  notePath: string,
): Effect.Effect<NoteContent, NoteFetchError, NoteGateway> =>
  Effect.gen(function* () {
    const gateway = yield* NoteGateway;
    return yield* gateway.fetchNote(ref, notePath);
  });
