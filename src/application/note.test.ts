import { Effect, Either, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { NoteFetchError, NoteGateway, openNote } from '@/application/note';
import type { NoteContent } from '@/application/note';
import type { VaultRef } from '@/domain/vault';

const REF: VaultRef = { owner: 'octocat', name: 'notes' };
const NOTE_PATH = 'daily/2026-08-08.md';
const NOTE: NoteContent = { path: NOTE_PATH, sha: 'mock-sha-1', content: '# 2026-08-08\n' };

function createGatewayStub(note: NoteContent): NoteGateway {
  return {
    fetchNote: vi
      .fn<(ref: VaultRef, notePath: string) => Effect.Effect<NoteContent, NoteFetchError>>()
      .mockReturnValue(Effect.succeed(note)),
  };
}

function provideStub(gateway: NoteGateway) {
  return Layer.succeed(NoteGateway, gateway);
}

describe('note ユースケース', () => {
  it('openNote はゲートウェイのノート内容（本文 + sha）を返す', async () => {
    const gateway = createGatewayStub(NOTE);
    const result = await Effect.runPromise(
      Effect.provide(openNote(REF, NOTE_PATH), provideStub(gateway)),
    );
    expect(result).toEqual(NOTE);
    expect(gateway.fetchNote).toHaveBeenCalledWith(REF, NOTE_PATH);
  });

  it('ゲートウェイのエラーは NoteFetchError として伝播する', async () => {
    const gateway: NoteGateway = {
      fetchNote: vi
        .fn<(ref: VaultRef, notePath: string) => Effect.Effect<NoteContent, NoteFetchError>>()
        .mockReturnValue(Effect.fail(new NoteFetchError('not_found', 'ノートが見つかりません。'))),
    };
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(openNote(REF, NOTE_PATH), provideStub(gateway))),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(NoteFetchError);
      expect(result.left.kind).toBe('not_found');
    }
  });
});
