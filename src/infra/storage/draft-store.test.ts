/**
 * Draft ストレージ（localStorage 実装）のユニットテスト。
 *
 * キー形式・値の往復・破棄・エラー種別（unavailable / quota）を固定する。
 * ブラウザの localStorage には依存せず、インメモリの KeyValueStorage を注入する。
 */

import { Effect, Either } from 'effect';
import { describe, expect, it } from 'vitest';

import { DraftStore, DraftStoreError, clearDraft, loadDraft, saveDraft } from '@/application/draft';
import type { VaultRef } from '@/domain/vault';
import { createDraftStoreLive, type KeyValueStorage } from '@/infra/storage/draft-store';

const REF: VaultRef = { owner: 'octocat', name: 'notes' };
const NOTE_PATH = 'daily/2026-08-08.md';

/** localStorage 互換のインメモリストレージ */
class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function runWith<A>(
  storage: KeyValueStorage,
  program: Effect.Effect<A, DraftStoreError, DraftStore>,
): Promise<A> {
  // 正常系テスト: 失敗は orDie で例外として投げてテストを失敗させる
  return Effect.runPromise(Effect.orDie(Effect.provide(program, createDraftStoreLive(storage))));
}

describe('Draft ストレージ（localStorage 実装）', () => {
  it('saveDraft → loadDraft で本文が往復し、キーは draft:<owner>/<repo>:<path> 形式になる', async () => {
    const storage = new MemoryStorage();
    await runWith(storage, saveDraft(REF, NOTE_PATH, '# 未保存の編集\n'));

    const draft = (await runWith(storage, loadDraft(REF, NOTE_PATH))) as {
      path: string;
      content: string;
    } | null;
    expect(draft).toEqual({ path: NOTE_PATH, content: '# 未保存の編集\n' });
    expect([...storage.map.keys()]).toEqual(['draft:octocat/notes:daily/2026-08-08.md']);
  });

  it('Draft がなければ loadDraft は null を返す', async () => {
    const storage = new MemoryStorage();
    const draft = await runWith(storage, loadDraft(REF, 'missing.md'));
    expect(draft).toBeNull();
  });

  it('clearDraft は保存済み Draft を破棄する', async () => {
    const storage = new MemoryStorage();
    await runWith(storage, saveDraft(REF, NOTE_PATH, '# 未保存の編集\n'));
    await runWith(storage, clearDraft(REF, NOTE_PATH));
    expect(storage.map.size).toBe(0);
    expect(await runWith(storage, loadDraft(REF, NOTE_PATH))).toBeNull();
  });

  it('setItem の失敗（容量超過）は kind: quota の DraftStoreError になる', async () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(saveDraft(REF, NOTE_PATH, 'x'), createDraftStoreLive(storage))),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(DraftStoreError);
      expect(result.left.kind).toBe('quota');
    }
  });

  it('getItem の失敗は kind: unavailable の DraftStoreError になる', async () => {
    const storage = new MemoryStorage();
    storage.getItem = () => {
      throw new Error('Storage disabled');
    };
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(loadDraft(REF, NOTE_PATH), createDraftStoreLive(storage))),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(DraftStoreError);
      expect(result.left.kind).toBe('unavailable');
    }
  });
});
