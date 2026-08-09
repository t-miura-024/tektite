/**
 * ノート系ユースケース（M1: ノート読み込みと CM6 エディタ基盤 / M3: 保存）。
 *
 * ノート（Markdown ファイル）の本文と sha を取得し、保存する。sha は保存時の
 * 楽観ロック（M3）に使うため、本文と常にセットで返す。保存時のコミット
 * メッセージは自動生成（`Update <ファイル名>` / `Create <ファイル名>`）で、
 * ユーザー入力は求めない（方針: 自動生成テンプレート）。
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

/** ノート保存エラーの種類（UI がトーストと Conflict 導線を選ぶ材料） */
export type NoteSaveErrorKind =
  | 'unauthenticated'
  | 'rate_limited'
  | 'conflict'
  | 'not_found'
  | 'server'
  | 'network';

/** ノート保存の通信で発生するエラー */
export class NoteSaveError extends Error {
  readonly kind: NoteSaveErrorKind;

  constructor(kind: NoteSaveErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NoteSaveError';
    this.kind = kind;
  }
}

/** 保存の入力（楽観ロックの基準 sha は読込時のものを必ず渡す） */
export interface NoteSaveInput {
  /** 保存する本文（UTF-8 のテキスト） */
  readonly content: string;
  /**
   * 読込時に取得した sha（楽観ロック）。null は「新規作成」を意味し、
   * コミットメッセージが `Create <ファイル名>` になり、PUT に sha を含めない。
   */
  readonly baseSha: string | null;
}

/** ノート保存の結果（保存後のファイル sha。Conflict 解決後の再保存に使える） */
export interface NoteSaveResult {
  readonly path: string;
  readonly sha: string;
}

/** Vault 全ノートの一括取得データ（プロキシ /api/notes/:owner/:repo/all の応答） */
export interface NoteIndexData {
  readonly defaultBranch: string;
  readonly truncated: boolean;
  readonly notes: readonly NoteContent[];
}

/**
 * ポートへの保存要求（コミットメッセージはユースケースが自動生成したもの）。
 * sha が null の場合は新規作成（Contents API の sha 省略）として扱う。
 */
export interface NoteSaveRequest {
  readonly content: string;
  readonly sha: string | null;
  readonly message: string;
}

/**
 * 一括コミットの変更 1 件（M5: ファイル操作）。
 *
 * - create / update: path に本文（UTF-8）を置く。base64 化は infra 層が行う
 * - create-binary: 画像などバイナリを標準 base64（btoa 互換）のまま置く
 *   （UTF-8 テキスト経由にすると二重エンコードで壊れるため。M2 画像アップロード）
 * - delete: path のファイルを削除する（GitHub 上の実削除）
 * - move: from（path）を to へ移動する。本文は転送せず、サーバー側が base tree
 *   の blob sha を再利用する（添付ファイルなど本文をクライアントに持たない
 *   ファイルもディレクトリ移動で正しく動く。M5 方針 2 の一括コミット）
 */
export type FileChange =
  | { readonly op: 'create'; readonly path: string; readonly content: string }
  | { readonly op: 'create-binary'; readonly path: string; readonly base64: string }
  | { readonly op: 'update'; readonly path: string; readonly content: string }
  | { readonly op: 'delete'; readonly path: string }
  | { readonly op: 'move'; readonly path: string; readonly to: string };

/** 一括コミットの入力（changes を 1 コミットに束ねる） */
export interface CommitChangesInput {
  readonly changes: readonly FileChange[];
  readonly message: string;
}

/** 一括コミットの結果 */
export interface CommitResult {
  readonly owner: string;
  readonly name: string;
  readonly branch: string;
  readonly commitSha: string;
}

/** 一括コミットエラーの種類（ノート保存と同じ kind 合併型） */
export type FileCommitErrorKind =
  | 'unauthenticated'
  | 'rate_limited'
  | 'conflict'
  | 'not_found'
  | 'server'
  | 'network';

/** 一括コミットの通信・検証で発生するエラー */
export class FileCommitError extends Error {
  readonly kind: FileCommitErrorKind;

  constructor(kind: FileCommitErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FileCommitError';
    this.kind = kind;
  }
}

/**
 * ポート: ノート本文と sha の取得・保存（Effect Service）。
 * src/infra/github の NoteGatewayLive（Pages Functions 経由）が実装する。
 */
export interface NoteGateway {
  readonly fetchNote: (
    ref: VaultRef,
    notePath: string,
  ) => Effect.Effect<NoteContent, NoteFetchError>;
  readonly fetchAllNotes: (ref: VaultRef) => Effect.Effect<NoteIndexData, NoteFetchError>;
  readonly saveNote: (
    ref: VaultRef,
    notePath: string,
    request: NoteSaveRequest,
  ) => Effect.Effect<NoteSaveResult, NoteSaveError>;
  /**
   * 複数ファイルの変更（作成/更新/削除/移動）を単一コミットで適用する（M5）。
   * リネーム/移動に伴うリンク張り替えは必ずこの一括コミットに束ねる（方針 2）。
   */
  readonly commitChanges: (
    ref: VaultRef,
    input: CommitChangesInput,
  ) => Effect.Effect<CommitResult, FileCommitError>;
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

/** ファイル名（コミットメッセージ用のパス末尾セグメント） */
function noteFileName(notePath: string): string {
  const segments = notePath.split('/');
  return segments[segments.length - 1] ?? notePath;
}

/**
 * ノートを保存する（コミットメッセージは自動生成）。
 * baseSha が null なら新規作成（`Create <ファイル名>`）、sha を持つなら更新
 * （`Update <ファイル名>`）として Contents API に渡す。リモートが読込時から
 * 変更されていた場合は NoteSaveError('conflict') で返り、UI は Conflict を
 * 識別できる（データ損失を防ぐ楽観ロック）。
 */
export const saveNoteContent = (
  ref: VaultRef,
  notePath: string,
  input: NoteSaveInput,
): Effect.Effect<NoteSaveResult, NoteSaveError, NoteGateway> => {
  const message =
    input.baseSha === null
      ? `Create ${noteFileName(notePath)}`
      : `Update ${noteFileName(notePath)}`;
  return Effect.gen(function* () {
    const gateway = yield* NoteGateway;
    return yield* gateway.saveNote(ref, notePath, {
      content: input.content,
      sha: input.baseSha,
      message,
    });
  });
};
