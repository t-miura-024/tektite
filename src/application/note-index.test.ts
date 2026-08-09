/**
 * ノート索引（src/application/note-index.ts）のユニットテスト。
 *
 * レジストリのメモリ展開（Vault 単位のキャッシュ）、保存後の反映（applySaved）、
 * ゲートウェイエラーの伝播を検証する。
 */

import { Effect, Either, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { NoteFetchError, NoteGateway } from '@/application/note';
import type { NoteIndexData } from '@/application/note';
import {
  NoteIndexRegistry,
  applySavedNote,
  createNoteIndexRegistry,
  loadNoteIndex,
} from '@/application/note-index';
import type { VaultRef } from '@/domain/vault';

const REF: VaultRef = { owner: 'octocat', name: 'notes' };
const OTHER_REF: VaultRef = { owner: 'octocat', name: 'other' };

const DATA: NoteIndexData = {
  defaultBranch: 'main',
  truncated: false,
  notes: [
    { path: 'README.md', sha: 'sha-readme', content: '# README\n' },
    { path: 'daily/2026-08-08.md', sha: 'sha-daily', content: '# 2026-08-08\n' },
  ],
};

/** ゲートウェイをモックしたレジストリ環境でユースケースを実行する */
function provide(registry: NoteIndexRegistry, gateway: NoteGateway) {
  return Layer.merge(
    Layer.succeed(NoteGateway, gateway),
    Layer.succeed(NoteIndexRegistry, registry),
  );
}

/** 既定のモックゲートウェイ（fetchAllNotes が DATA を返す） */
function mockGateway(fetchAllNotes = vi.fn().mockReturnValue(Effect.succeed(DATA))): NoteGateway {
  return { fetchAllNotes } as unknown as NoteGateway;
}

describe('ノート索引レジストリ', () => {
  it('load はゲートウェイの全ノートをパス → 内容の Map に展開する', async () => {
    const registry = createNoteIndexRegistry();
    const gateway = mockGateway();

    const index = await Effect.runPromise(
      Effect.provide(loadNoteIndex(REF), provide(registry, gateway)),
    );

    expect(index.ref).toEqual(REF);
    expect(index.defaultBranch).toBe('main');
    expect([...index.notes.keys()]).toEqual(['README.md', 'daily/2026-08-08.md']);
    expect(index.notes.get('README.md')).toEqual({
      path: 'README.md',
      sha: 'sha-readme',
      content: '# README\n',
    });
    expect(gateway.fetchAllNotes).toHaveBeenCalledWith(REF);
  });

  it('load は同じ Vault の 2 回目以降を再取得せず、保持済みの索引を返す', async () => {
    const registry = createNoteIndexRegistry();
    const gateway = mockGateway();

    const first = await Effect.runPromise(
      Effect.provide(loadNoteIndex(REF), provide(registry, gateway)),
    );
    const second = await Effect.runPromise(
      Effect.provide(loadNoteIndex(REF), provide(registry, gateway)),
    );

    expect(second).toBe(first);
    expect(gateway.fetchAllNotes).toHaveBeenCalledTimes(1);
  });

  it('load は Vault（owner/name）ごとに別の索引を展開する', async () => {
    const registry = createNoteIndexRegistry();
    const gateway = mockGateway(
      vi
        .fn()
        .mockReturnValueOnce(Effect.succeed(DATA))
        .mockReturnValueOnce(
          Effect.succeed({
            ...DATA,
            notes: [{ path: 'other.md', sha: 'sha-other', content: '# x\n' }],
          }),
        ),
    );

    const first = await Effect.runPromise(
      Effect.provide(loadNoteIndex(REF), provide(registry, gateway)),
    );
    const second = await Effect.runPromise(
      Effect.provide(loadNoteIndex(OTHER_REF), provide(registry, gateway)),
    );

    expect(first.notes.has('README.md')).toBe(true);
    expect(second.notes.has('README.md')).toBe(false);
    expect(second.notes.has('other.md')).toBe(true);
    expect(gateway.fetchAllNotes).toHaveBeenCalledTimes(2);
  });

  it('get は未ロードの Vault に null、ロード済みは索引を返す', async () => {
    const registry = createNoteIndexRegistry();
    const gateway = mockGateway();

    expect(registry.get(REF)).toBeNull();

    await Effect.runPromise(Effect.provide(loadNoteIndex(REF), provide(registry, gateway)));

    expect(registry.get(REF)?.notes.size).toBe(2);
  });

  it('applySaved は既存ノートの本文を更新し、取得時点の sha を保持する', async () => {
    const registry = createNoteIndexRegistry();
    const gateway = mockGateway();
    await Effect.runPromise(Effect.provide(loadNoteIndex(REF), provide(registry, gateway)));

    const updated = await Effect.runPromise(
      Effect.provide(
        applySavedNote(REF, 'README.md', '# README 更新\n'),
        provide(registry, gateway),
      ),
    );

    expect(updated?.notes.get('README.md')).toEqual({
      path: 'README.md',
      sha: 'sha-readme',
      content: '# README 更新\n',
    });
    expect(updated).toBe(registry.get(REF));
  });

  it('applySaved は索引にないパス（新規ノート）を sha 未確定（空文字）で追加する', async () => {
    const registry = createNoteIndexRegistry();
    const gateway = mockGateway();
    await Effect.runPromise(Effect.provide(loadNoteIndex(REF), provide(registry, gateway)));

    const updated = await Effect.runPromise(
      Effect.provide(applySavedNote(REF, 'new-note.md', '# 新規\n'), provide(registry, gateway)),
    );

    expect(updated?.notes.get('new-note.md')).toEqual({
      path: 'new-note.md',
      sha: '',
      content: '# 新規\n',
    });
  });

  it('applySaved は未ロードの Vault には null を返し、何も変更しない', async () => {
    const registry = createNoteIndexRegistry();
    const gateway = mockGateway();

    const updated = await Effect.runPromise(
      Effect.provide(applySavedNote(REF, 'README.md', '# x\n'), provide(registry, gateway)),
    );

    expect(updated).toBeNull();
    expect(gateway.fetchAllNotes).not.toHaveBeenCalled();
  });

  it('load はゲートウェイのエラーを NoteFetchError として伝播し、キャッシュしない', async () => {
    const registry = createNoteIndexRegistry();
    const gateway = mockGateway(
      vi
        .fn()
        .mockReturnValue(Effect.fail(new NoteFetchError('rate_limited', 'レートリミットです。'))),
    );

    const result = await Effect.runPromise(
      Effect.either(Effect.provide(loadNoteIndex(REF), provide(registry, gateway))),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(NoteFetchError);
      expect(result.left.kind).toBe('rate_limited');
    }
    expect(registry.get(REF)).toBeNull();
  });
});
