/**
 * 共有ノート索引から検索・記法索引・パス一覧を導出するフック群。
 */

import { useMemo } from 'react';

import type { NoteIndex } from '@/application/note-index';
import { createNoteSearcher, type NoteSearcher, type SearchableNote } from '@/application/search';
import { buildNotationIndex, type VaultNotationIndex } from '@/domain/notation/index';

import { collectFilePaths } from '@/ui/screens/vault-screen/screen-utils';
import type { TreeState } from '@/ui/screens/vault-screen/use-vault-loader';

export type DerivedIndexes = {
  notation: VaultNotationIndex | null;
  searcher: NoteSearcher | null;
  /** クイックスイッチャー用のノートパス一覧（null は索引未ロード） */
  notePaths: readonly string[] | null;
};

/** 共有索引からバックリンク / タグ索引を構築する（M2 / M3 のスコープ） */
function useDerivedNotation(
  state: TreeState,
  noteIndex: NoteIndex | null,
): VaultNotationIndex | null {
  return useMemo(() => {
    if (noteIndex === null || state.kind !== 'ready') {
      return null;
    }
    const paths = collectFilePaths(state.tree.root);
    const contents = new Map<string, string>();
    for (const note of noteIndex.notes.values()) {
      contents.set(note.path, note.content);
    }
    return buildNotationIndex({ filePaths: paths, contents });
  }, [noteIndex, state]);
}

/** 全文検索器: 共有索引（本文 + パス）と記法索引（タグ）を統合して構築する（M2） */
function useDerivedSearcher(state: TreeState, noteIndex: NoteIndex | null): NoteSearcher | null {
  const notation = useDerivedNotation(state, noteIndex);
  return useMemo(() => {
    if (noteIndex === null || notation === null) {
      return null;
    }
    const notes: SearchableNote[] = [];
    for (const note of noteIndex.notes.values()) {
      const notationNote = notation.notes.get(note.path);
      const bodyStart = notationNote?.frontmatter?.to;
      notes.push({
        path: note.path,
        content: bodyStart === undefined ? note.content : note.content.slice(bodyStart),
        tags: notationNote?.tags ?? [],
      });
    }
    return createNoteSearcher(notes);
  }, [noteIndex, notation]);
}

export function useDerivedIndexes(state: TreeState, noteIndex: NoteIndex | null): DerivedIndexes {
  const notation = useDerivedNotation(state, noteIndex);
  const searcher = useDerivedSearcher(state, noteIndex);
  const notePaths = useMemo(
    () => (noteIndex === null ? null : [...noteIndex.notes.keys()]),
    [noteIndex],
  );
  return { notation, searcher, notePaths };
}
