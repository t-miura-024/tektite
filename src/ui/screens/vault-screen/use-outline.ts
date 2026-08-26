/**
 * 補助ペインのアウトライン（見出し一覧）のソース本文の受け渡し。
 * NotePane の onNoteContentLoaded 経由で更新され、ノート切替でリセットする。
 */

import { useEffect, useMemo, useState } from 'react';

import { collectOutline, type OutlineHeading } from '@/ui/screens/vault-screen/screen-utils';

export type OutlineState = {
  outlineContent: string;
  setOutlineContent: (content: string) => void;
  outline: readonly OutlineHeading[];
};

export function useOutline(notePath: string | null): OutlineState {
  const [outlineContent, setOutlineContent] = useState('');
  const outline = useMemo(() => collectOutline(outlineContent), [outlineContent]);

  // Vault / ノートが変わったら前の内容を引き継がない
  useEffect(() => {
    setOutlineContent('');
  }, [notePath]);

  return { outlineContent, setOutlineContent, outline };
}
