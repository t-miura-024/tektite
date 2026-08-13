/**
 * ノート索引（M4: クライアント側ノート索引）。
 *
 * Vault の全ノートを一括取得し、ブラウザのメモリ上に展開して共有する。
 * 検索（M2）・クイックスイッチャー（M3）・バックリンク（M3 の buildNotationIndex）
 * が同一インスタンスを参照するための基盤。M3 まで VaultScreen が持っていた
 * ノート本文キャッシュ（contentsCacheRef）を application 層へ昇格させたもの。
 *
 * レジストリ（NoteIndexRegistry）は Vault（owner/name）単位で索引を保持し、
 * 同じ Vault の再ロード（ルーティング往来・リマウント）では再取得しない
 * （GitHub レートリミットの節約）。ページリロードでメモリが消えるため再取得
 * される（ADR-0004 の「メモリ展開」前提と整合）。
 *
 * 保存後の最新化は applySaved が担う。本文のみ更新し、sha は取得時点の値を
 * 保持する（楽観ロックの基準 sha は NotePane が読込時とは別に管理している）。
 */

import { Context, Effect, Layer } from 'effect';

import { NoteFetchError, NoteGateway } from '@/application/note';
import type { FileChange, NoteContent } from '@/application/note';
import type { VaultRef } from '@/domain/vault';

/** Vault 全ノートの共有メモリ索引（検索・クイックスイッチャー・バックリンクで共用） */
export interface NoteIndex {
  readonly ref: VaultRef;
  readonly defaultBranch: string;
  readonly truncated: boolean;
  /** ノートパス → 内容（本文 + 取得時点の sha）。取得失敗ノートは含まれない */
  readonly notes: ReadonlyMap<string, NoteContent>;
}

/**
 * ノート索引の共有レジストリ（Effect Service）。
 * このサービスを介せば、検索・クイックスイッチャー・バックリンクパネルが
 * 同一の索引インスタンス（NoteIndex.notes）を参照できる。
 */
export interface NoteIndexRegistry {
  /** Vault の全ノートを取得してメモリ展開する（既に展開済みならそれを返す） */
  readonly load: (ref: VaultRef) => Effect.Effect<NoteIndex, NoteFetchError, NoteGateway>;
  /** 展開済みの索引を返す（未展開は null） */
  readonly get: (ref: VaultRef) => NoteIndex | null;
  /** 保存後の本文を索引へ反映し、更新後の索引を返す（未展開は null） */
  readonly applySaved: (ref: VaultRef, notePath: string, content: string) => NoteIndex | null;
  /**
   * 一括コミット（ファイル操作）後の索引を反映し、更新後の索引を返す（M5）。
   * move は元パスの本文を新パスへ引き継ぎ、delete は除去、create/update は
   * 本文を差し替える。changes の順に適用する（move 後の update で張り替え後
   * 本文が勝つ）。未展開は null。
   */
  readonly applyFileChanges: (ref: VaultRef, changes: readonly FileChange[]) => NoteIndex | null;
}
export const NoteIndexRegistry = Context.GenericTag<NoteIndexRegistry>('tektite/NoteIndexRegistry');

/** Vault を表すレジストリキー（owner/name で索引を分ける） */
function registryKey(ref: VaultRef): string {
  return `${ref.owner}/${ref.name}`;
}

/** レジストリの本番実装（Vault 単位の索引 Map を内部に持つ） */
export const NoteIndexRegistryLive: Layer.Layer<NoteIndexRegistry> = Layer.sync(
  NoteIndexRegistry,
  () => createNoteIndexRegistry(),
);

/** テスト用に分離したレジストリ factory（内部状態はクロージャが保持する） */
export function createNoteIndexRegistry(): NoteIndexRegistry {
  const indexes = new Map<string, NoteIndex>();
  return {
    load: (ref) =>
      Effect.gen(function* () {
        const cached = indexes.get(registryKey(ref));
        if (cached !== undefined) {
          return cached;
        }
        const gateway = yield* NoteGateway;
        const data = yield* gateway.fetchAllNotes(ref);
        const index: NoteIndex = {
          ref,
          defaultBranch: data.defaultBranch,
          truncated: data.truncated,
          notes: new Map(data.notes.map((note) => [note.path, note])),
        };
        indexes.set(registryKey(ref), index);
        return index;
      }),
    get: (ref) => indexes.get(registryKey(ref)) ?? null,
    applySaved: (ref, notePath, content) => {
      const index = indexes.get(registryKey(ref));
      if (index === undefined) {
        return null;
      }
      const existing = index.notes.get(notePath);
      // 新規ノート（索引にないパス）は sha 未確定（空文字）として追加する
      const updated =
        existing === undefined ? { path: notePath, sha: '', content } : { ...existing, content };
      const notes = new Map(index.notes);
      notes.set(notePath, updated);
      const next = { ...index, notes };
      indexes.set(registryKey(ref), next);
      return next;
    },
    applyFileChanges: (ref, changes) => {
      const index = indexes.get(registryKey(ref));
      if (index === undefined) {
        return null;
      }
      const notes = new Map(index.notes);
      for (const change of changes) {
        if (change.op === 'delete') {
          notes.delete(change.path);
        } else if (change.op === 'move') {
          const source = notes.get(change.path);
          if (source !== undefined) {
            // 本文は元パスのものを引き継ぐ（張り替え後の update が後続で上書きする）
            notes.set(change.to, { path: change.to, sha: '', content: source.content });
          }
          notes.delete(change.path);
        } else if (change.op === 'copy') {
          const source = notes.get(change.path);
          if (source !== undefined) {
            // 複製は元の本文をそのまま引き継ぐ（WikiLink は張り替えない）
            notes.set(change.to, { path: change.to, sha: '', content: source.content });
          }
        } else if (change.op === 'create-binary') {
          // 添付（画像）はノート索引の対象外（検索・クイックスイッチャーに混ぜない）
          notes.delete(change.path);
        } else {
          notes.set(change.path, { path: change.path, sha: '', content: change.content });
        }
      }
      const next = { ...index, notes };
      indexes.set(registryKey(ref), next);
      return next;
    },
  };
}

/** Vault の全ノートを共有索引へ展開する（既に展開済みならそれを返す） */
export const loadNoteIndex = (
  ref: VaultRef,
): Effect.Effect<NoteIndex, NoteFetchError, NoteIndexRegistry | NoteGateway> =>
  Effect.gen(function* () {
    const registry = yield* NoteIndexRegistry;
    return yield* registry.load(ref);
  });

/** 保存後の本文を共有索引へ反映し、更新後の索引を返す（未展開は null） */
export const applySavedNote = (
  ref: VaultRef,
  notePath: string,
  content: string,
): Effect.Effect<NoteIndex | null, never, NoteIndexRegistry> =>
  Effect.gen(function* () {
    const registry = yield* NoteIndexRegistry;
    return registry.applySaved(ref, notePath, content);
  });
