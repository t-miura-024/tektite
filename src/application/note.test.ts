import { Effect, Either, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import {
  isNoteFetchError,
  isNoteSaveError,
  NoteGateway,
  noteFetchError,
  noteSaveError,
  openNote,
  saveNoteContent,
  type NoteContent,
  type NoteFetchError,
  type NoteIndexData,
  type NoteSaveError,
  type NoteSaveRequest,
  type NoteSaveResult,
} from '@/application/note';
import type { VaultRef } from '@/domain/vault';

const REF: VaultRef = { owner: 'octocat', name: 'notes' };
const NOTE_PATH = 'daily/2026-08-08.md';
const NOTE: NoteContent = { path: NOTE_PATH, sha: 'mock-sha-1', content: '# 2026-08-08\n' };
const SAVE_RESULT: NoteSaveResult = { path: NOTE_PATH, sha: 'mock-sha-2' };
const INDEX_DATA: NoteIndexData = {
  defaultBranch: 'main',
  truncated: false,
  notes: [NOTE],
};

type GatewayStub = {
  gateway: NoteGateway;
  fetchNoteMock: ReturnType<typeof vi.fn>;
  saveNoteMock: ReturnType<typeof vi.fn>;
};

function createGatewayStub(note: NoteContent): GatewayStub {
  const fetchNote = vi
    .fn<(ref: VaultRef, notePath: string) => Effect.Effect<NoteContent, NoteFetchError>>()
    .mockReturnValue(Effect.succeed(note));
  const saveNote = vi
    .fn<
      (
        ref: VaultRef,
        notePath: string,
        request: NoteSaveRequest,
      ) => Effect.Effect<NoteSaveResult, NoteSaveError>
    >()
    .mockReturnValue(Effect.succeed(SAVE_RESULT));
  const fetchAllNotes = vi
    .fn<(ref: VaultRef) => Effect.Effect<NoteIndexData, NoteFetchError>>()
    .mockReturnValue(Effect.succeed(INDEX_DATA));
  const commitChanges = vi.fn();
  return {
    gateway: { fetchNote, fetchAllNotes, saveNote, commitChanges },
    fetchNoteMock: fetchNote,
    saveNoteMock: saveNote,
  };
}

function provideStub(gateway: NoteGateway) {
  return Layer.succeed(NoteGateway, gateway);
}

describe('note ユースケース', () => {
  it('openNote はゲートウェイのノート内容（本文 + sha）を返す', async () => {
    const { gateway, fetchNoteMock } = createGatewayStub(NOTE);
    const result = await Effect.runPromise(
      Effect.provide(openNote(REF, NOTE_PATH), provideStub(gateway)),
    );
    expect(result).toEqual(NOTE);
    expect(fetchNoteMock).toHaveBeenCalledWith(REF, NOTE_PATH);
  });

  it('ゲートウェイのエラーは NoteFetchError として伝播する', async () => {
    const gateway: NoteGateway = {
      fetchNote: vi
        .fn<(ref: VaultRef, notePath: string) => Effect.Effect<NoteContent, NoteFetchError>>()
        .mockReturnValue(Effect.fail(noteFetchError('not_found', 'ノートが見つかりません。'))),
      fetchAllNotes: vi.fn(),
      saveNote: vi.fn(),
      commitChanges: vi.fn(),
    };
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(openNote(REF, NOTE_PATH), provideStub(gateway))),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(isNoteFetchError(result.left)).toBe(true);
      expect(result.left.kind).toBe('not_found');
    }
  });

  it('saveNoteContent は既存ノートを Update メッセージで保存する', async () => {
    const { gateway, saveNoteMock } = createGatewayStub(NOTE);
    const result = await Effect.runPromise(
      Effect.provide(
        saveNoteContent(REF, NOTE_PATH, { content: '# 更新後\n', baseSha: 'mock-sha-1' }),
        provideStub(gateway),
      ),
    );
    expect(result).toEqual(SAVE_RESULT);
    expect(saveNoteMock).toHaveBeenCalledWith(REF, NOTE_PATH, {
      content: '# 更新後\n',
      sha: 'mock-sha-1',
      message: 'Update 2026-08-08.md',
    });
  });

  it('saveNoteContent は baseSha が null の新規ノートを Create メッセージで保存する', async () => {
    const { gateway, saveNoteMock } = createGatewayStub(NOTE);
    const result = await Effect.runPromise(
      Effect.provide(
        saveNoteContent(REF, 'new-note.md', { content: '# 新規\n', baseSha: null }),
        provideStub(gateway),
      ),
    );
    expect(result).toEqual(SAVE_RESULT);
    expect(saveNoteMock).toHaveBeenCalledWith(REF, 'new-note.md', {
      content: '# 新規\n',
      sha: null,
      message: 'Create new-note.md',
    });
  });

  it('ゲートウェイの conflict は NoteSaveError(kind: conflict) として伝播する', async () => {
    const gateway: NoteGateway = {
      fetchNote: vi.fn(),
      fetchAllNotes: vi.fn(),
      saveNote: vi
        .fn()
        .mockReturnValue(
          Effect.fail(noteSaveError('conflict', 'リモートの内容が変更されていました。')),
        ),
      commitChanges: vi.fn(),
    };
    const result = await Effect.runPromise(
      Effect.either(
        Effect.provide(
          saveNoteContent(REF, NOTE_PATH, { content: '# x\n', baseSha: 'stale-sha' }),
          provideStub(gateway),
        ),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(isNoteSaveError(result.left)).toBe(true);
      expect(result.left.kind).toBe('conflict');
    }
  });
});
