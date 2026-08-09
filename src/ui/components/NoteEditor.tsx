/**
 * CM6 エディタの React ラッパー。
 *
 * infra 層の createEditorView は UI から直接 import できない規約のため、
 * 組成ルート（src/composition）経由で生成する。エディタの実体は
 * opaque な EditorHandle として扱い、React はライフサイクル（生成/破棄）と
 * イベントの橋渡し（本文変更・フォーカス喪失・ハンドルの受け渡し）だけを担う。
 *
 * - onContentChange: 本文が変わるたびに呼ばれる（未保存判定・Draft 退避用）
 * - onBlur: エディタからフォーカスが離れるたびに呼ばれる（自動保存トリガー）
 * - onReady: エディタ生成/破棄時に呼ばれる（setContent 用のハンドル保持）
 *
 * notePath が変わると親が key を付けて作り直す想定（ノート切替時に確実に
 * 新ドキュメントで再生成される）。StrictMode の二重実行にも破棄処理で対応する。
 */

import { useEffect, useRef } from 'react';

import { createEditorView } from '@/composition';
import type { EditorHandle } from '@/composition';

export interface NoteEditorProps {
  /** ノートパス（アクセシビリティラベル用。内容の再生成は親の key が担う） */
  notePath: string;
  /** エディタに初期表示するノート本文 */
  initialContent: string;
  /** Vault 内の全ファイルパス（WikiLink / Embed / Tag 装飾とクリック遷移に使う） */
  filePaths?: readonly string[];
  /** WikiLink クリック時の遷移コールバック（解決済みパス + 見出し。null は見出しなし） */
  onWikilinkClick?: (path: string, subpath: string | null) => void;
  /** 本文が変わるたびに呼ばれる（未保存判定・Draft 退避のトリガー） */
  onContentChange?: (content: string) => void;
  /** エディタからのフォーカス喪失（自動保存のトリガー） */
  onBlur?: () => void;
  /** エディタ生成時（handle）/ 破棄時（null）に呼ばれる */
  onReady?: (handle: EditorHandle | null) => void;
}

export function NoteEditor({
  notePath,
  initialContent,
  filePaths,
  onWikilinkClick,
  onContentChange,
  onBlur,
  onReady,
}: NoteEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // コールバックは ref で常に最新を参照する（エディタの再生成を避ける）
  const callbacksRef = useRef({ onContentChange, onBlur, onWikilinkClick });
  callbacksRef.current = { onContentChange, onBlur, onWikilinkClick };
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const handle = createEditorView(container, initialContent, {
      filePaths,
      onWikilinkClick: (path, subpath) => callbacksRef.current.onWikilinkClick?.(path, subpath),
    });
    handle.onChange((content) => callbacksRef.current.onContentChange?.(content));
    handle.onBlur(() => callbacksRef.current.onBlur?.());
    onReadyRef.current?.(handle);
    return () => {
      handle.destroy();
      onReadyRef.current?.(null);
    };
  }, [initialContent, filePaths]);

  return (
    <div
      ref={containerRef}
      className="note-editor"
      data-testid="note-editor"
      aria-label={`ノート ${notePath} のエディタ`}
    />
  );
}
