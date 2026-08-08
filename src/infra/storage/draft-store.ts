/**
 * Draft ストレージの localStorage 実装（Effect Layer）。
 *
 * キーは `draft:<owner>/<repo>:<path>` 形式（例: draft:octocat/notes:daily/2026-08-08.md）。
 * 値は本文（UTF-8 文字列）そのままを保存する。
 *
 * localStorage はブラウザ専用のため、テストでは createDraftStoreLive に
 * インメモリの KeyValueStorage を渡して検証する。本番（DraftStoreLive）は
 * localStorage を遅延解決し、利用できない環境（プライベートモードや非ブラウザ）
 * では DraftStoreError('unavailable') で失敗させる。
 */

import { Effect, Layer } from 'effect';

import { DraftStore, DraftStoreError } from '@/application/draft';
import type { VaultRef } from '@/domain/vault';

/** localStorage 互換の最小インターフェース（テストで差し替え可能にする） */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY_PREFIX = 'draft:';

/** Draft の保存キー（draft:<owner>/<repo>:<path> 形式） */
function draftKey(ref: VaultRef, notePath: string): string {
  return `${KEY_PREFIX}${ref.owner}/${ref.name}:${notePath}`;
}

/** localStorage が利用できない環境用のスタブ（全操作が unavailable で失敗する） */
const unavailableStorage: KeyValueStorage = {
  getItem(): never {
    throw new DraftStoreError('unavailable', 'この環境ではローカルストレージを利用できません。');
  },
  setItem(): never {
    throw new DraftStoreError('unavailable', 'この環境ではローカルストレージを利用できません。');
  },
  removeItem(): never {
    throw new DraftStoreError('unavailable', 'この環境ではローカルストレージを利用できません。');
  },
};

/** ブラウザの localStorage を解決する（なければ unavailable スタブを返す） */
function resolveBrowserStorage(): KeyValueStorage {
  const storage = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
  return typeof storage === 'undefined' || storage === null ? unavailableStorage : storage;
}

/** 指定ストレージに DraftStore の実装を構築する（テストはここに差し替えストレージを渡す） */
export function createDraftStoreLive(storage: KeyValueStorage): Layer.Layer<DraftStore> {
  return Layer.succeed(DraftStore, {
    get: (ref: VaultRef, notePath: string) =>
      Effect.gen(function* () {
        const raw = yield* Effect.try({
          try: () => storage.getItem(draftKey(ref, notePath)),
          catch: (error) =>
            new DraftStoreError('unavailable', 'Draft の読み出しに失敗しました。', {
              cause: error,
            }),
        });
        return raw === null ? null : { path: notePath, content: raw };
      }),

    set: (ref: VaultRef, notePath: string, content: string) =>
      Effect.try({
        try: () => storage.setItem(draftKey(ref, notePath), content),
        catch: (error) =>
          new DraftStoreError('quota', 'Draft を保存できませんでした（容量不足）。', {
            cause: error,
          }),
      }),

    remove: (ref: VaultRef, notePath: string) =>
      Effect.try({
        try: () => storage.removeItem(draftKey(ref, notePath)),
        catch: (error) =>
          new DraftStoreError('unavailable', 'Draft の破棄に失敗しました。', {
            cause: error,
          }),
      }),
  });
}

/** 本番実装（ブラウザの localStorage を使う） */
export const DraftStoreLive: Layer.Layer<DraftStore> =
  createDraftStoreLive(resolveBrowserStorage());
