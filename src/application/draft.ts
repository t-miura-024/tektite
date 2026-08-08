/**
 * Draft 系ユースケース（M3: 未保存編集バッファの localStorage 退避）。
 *
 * Draft は保存前の編集バッファをブラウザのローカルストレージに退避したもの
 * （CONTEXT.md 参照）。リロードや誤クローズ後、次回ノートを開いたときに復元
 * 通知するために使う。キーは実装（src/infra/storage）が `draft:<owner>/<repo>:<path>`
 * 形式で採番する。
 *
 * GitHub やサーバーには触れず、ポート（DraftStore）経由でだけ永続化に触れる。
 * ポートは Effect Service（Tag）として定義し、具体実装（Layer）は src/infra が、
 * 組成は src/composition が担う（src/application/note.ts と同じ仕組み）。
 */

import { Context, Effect } from 'effect';

import type { VaultRef } from '@/domain/vault';

/** Draft ストレージエラーの種類（UI がトーストの出し分けに使える） */
export type DraftStoreErrorKind = 'unavailable' | 'quota';

/** Draft の読み書きで発生するエラー */
export class DraftStoreError extends Error {
  readonly kind: DraftStoreErrorKind;

  constructor(kind: DraftStoreErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DraftStoreError';
    this.kind = kind;
  }
}

/** 退避された Draft（保存時に復元するための情報） */
export interface Draft {
  /** Vault ルートからのノートパス（/ 区切り） */
  readonly path: string;
  /** 未保存の本文（UTF-8 のテキスト） */
  readonly content: string;
}

/**
 * ポート: Draft の退避・復元（Effect Service）。
 * src/infra/storage の DraftStoreLive（localStorage 実装）が提供する。
 */
export interface DraftStore {
  readonly get: (ref: VaultRef, notePath: string) => Effect.Effect<Draft | null, DraftStoreError>;
  readonly set: (
    ref: VaultRef,
    notePath: string,
    content: string,
  ) => Effect.Effect<void, DraftStoreError>;
  readonly remove: (ref: VaultRef, notePath: string) => Effect.Effect<void, DraftStoreError>;
}
export const DraftStore = Context.GenericTag<DraftStore>('tektite/DraftStore');

/** 退避済み Draft を取得する（なければ null） */
export const loadDraft = (
  ref: VaultRef,
  notePath: string,
): Effect.Effect<Draft | null, DraftStoreError, DraftStore> =>
  Effect.gen(function* () {
    const store = yield* DraftStore;
    return yield* store.get(ref, notePath);
  });

/** 未保存の本文を Draft として退避する（既存 Draft は上書き） */
export const saveDraft = (
  ref: VaultRef,
  notePath: string,
  content: string,
): Effect.Effect<void, DraftStoreError, DraftStore> =>
  Effect.gen(function* () {
    const store = yield* DraftStore;
    return yield* store.set(ref, notePath, content);
  });

/** 保存完了後に Draft を破棄する */
export const clearDraft = (
  ref: VaultRef,
  notePath: string,
): Effect.Effect<void, DraftStoreError, DraftStore> =>
  Effect.gen(function* () {
    const store = yield* DraftStore;
    return yield* store.remove(ref, notePath);
  });
