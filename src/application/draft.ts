/**
 * Draft 系ユースケース（M3: 未保存編集の退避）。
 * リロード後の復元通知に使う。GitHubに触れず DraftStore 経由で永続化する。
 * 実装は src/infra、組成は src/composition が担う。
 */

import { Context, Effect } from 'effect';

import { makeNamedError, isErrorNamed } from '@/application/error-object';
import type { VaultRef } from '@/domain/vault';

/** Draft ストレージエラーの種類（UI がトーストの出し分けに使える） */
export type DraftStoreErrorKind = 'unavailable' | 'quota';

/** Draft の読み書きで発生するエラー */
export type DraftStoreError = Error & {
  readonly kind: DraftStoreErrorKind;
};

/** DraftStoreError を生成するファクトリ */
export function draftStoreError(
  kind: DraftStoreErrorKind,
  message: string,
  options?: { cause?: unknown },
): DraftStoreError {
  return Object.assign(makeNamedError('DraftStoreError', message, options), { kind });
}

/** error が DraftStoreError かどうか */
export function isDraftStoreError(error: unknown): error is DraftStoreError {
  return isErrorNamed(error, 'DraftStoreError');
}

/** 退避された Draft（保存時に復元するための情報） */
export type Draft = {
  /** Vault ルートからのノートパス（/ 区切り） */
  readonly path: string;
  /** 未保存の本文（UTF-8 のテキスト） */
  readonly content: string;
};

/**
 * ポート: Draft の退避・復元（Effect Service）。
 * src/infra/storage の DraftStoreLive（localStorage 実装）が提供する。
 */
export type DraftStore = {
  readonly get: (ref: VaultRef, notePath: string) => Effect.Effect<Draft | null, DraftStoreError>;
  readonly set: (
    ref: VaultRef,
    notePath: string,
    content: string,
  ) => Effect.Effect<void, DraftStoreError>;
  readonly remove: (ref: VaultRef, notePath: string) => Effect.Effect<void, DraftStoreError>;
};
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
