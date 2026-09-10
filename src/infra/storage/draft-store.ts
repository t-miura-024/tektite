/**
 * Draft ストレージの localStorage 実装（Effect Layer）。
 * キーは `draft:<owner>/<repo>:<path>`、値は本文そのまま。
 * 非ブラウザ環境では unavailable で失敗させる。
 */

import { Effect, Layer } from 'effect';

import { draftStoreError, DraftStore } from '@/application/draft';
import type { VaultRef } from '@/domain/vault';

/** localStorage 互換の最小インターフェース（テストで差し替え可能にする） */
export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const KEY_PREFIX = 'draft:';

/** Draft の保存キー（draft:<owner>/<repo>:<path> 形式） */
function draftKey(ref: VaultRef, notePath: string): string {
  return `${KEY_PREFIX}${ref.owner}/${ref.name}:${notePath}`;
}

/** localStorage が利用できない環境用のスタブ（全操作が unavailable で失敗する） */
const unavailableStorage: KeyValueStorage = {
  getItem(): never {
    throw draftStoreError('unavailable', 'この環境ではローカルストレージを利用できません。');
  },
  setItem(): never {
    throw draftStoreError('unavailable', 'この環境ではローカルストレージを利用できません。');
  },
  removeItem(): never {
    throw draftStoreError('unavailable', 'この環境ではローカルストレージを利用できません。');
  },
};

/** 指定ストレージに DraftStore の実装を構築する（テストはここに差し替えストレージを渡す） */
export function createDraftStoreLive(storage: KeyValueStorage): Layer.Layer<DraftStore> {
  return Layer.succeed(DraftStore, {
    get: (ref: VaultRef, notePath: string) =>
      Effect.gen(function* () {
        const raw = yield* Effect.try({
          try: () => storage.getItem(draftKey(ref, notePath)),
          catch: (error) =>
            draftStoreError('unavailable', 'Draft の読み出しに失敗しました。', {
              cause: error,
            }),
        });
        return raw === null ? null : { path: notePath, content: raw };
      }),

    set: (ref: VaultRef, notePath: string, content: string) =>
      Effect.try({
        try: () => storage.setItem(draftKey(ref, notePath), content),
        catch: (error) =>
          draftStoreError('quota', 'Draft を保存できませんでした（容量不足）。', {
            cause: error,
          }),
      }),

    remove: (ref: VaultRef, notePath: string) =>
      Effect.try({
        try: () => storage.removeItem(draftKey(ref, notePath)),
        catch: (error) =>
          draftStoreError('unavailable', 'Draft の破棄に失敗しました。', {
            cause: error,
          }),
      }),
  });
}

/** 本番実装（ブラウザの localStorage を使う） */
export const DraftStoreLive: Layer.Layer<DraftStore> = createDraftStoreLive(
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- globalThis の localStorage は実行環境依存のため境界で型を確定する
  (globalThis as { localStorage?: KeyValueStorage }).localStorage ?? unavailableStorage,
);
