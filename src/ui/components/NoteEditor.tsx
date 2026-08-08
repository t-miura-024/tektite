/**
 * CM6 エディタの React ラッパー。
 *
 * infra 層の createEditorView は UI から直接 import できない規約のため、
 * 組成ルート（src/composition）経由で生成する。エディタの実体は
 * opaque な EditorHandle として扱い、React はライフサイクル（生成/破棄）だけを担う。
 *
 * notePath が変わると親が key を付けて作り直す想定（ノート切替時に確実に
 * 新ドキュメントで再生成される）。StrictMode の二重実行にも破棄処理で対応する。
 */

import { useEffect, useRef } from 'react';

import { createEditorView } from '@/composition';

export interface NoteEditorProps {
  /** ノートパス（アクセシビリティラベル用。内容の再生成は親の key が担う） */
  notePath: string;
  /** エディタに初期表示するノート本文 */
  initialContent: string;
}

export function NoteEditor({ notePath, initialContent }: NoteEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const handle = createEditorView(container, initialContent);
    return () => handle.destroy();
  }, [initialContent]);

  return (
    <div
      ref={containerRef}
      className="note-editor"
      data-testid="note-editor"
      aria-label={`ノート ${notePath} のエディタ`}
    />
  );
}
