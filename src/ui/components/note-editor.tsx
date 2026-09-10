/**
 * CM6 エディタの React ラッパー。生成は組成ルート経由で行い、実体は不透明なハンドルとして
 * 扱う。React は生成と破棄、変更・フォーカス・ハンドル受け渡しの橋渡しだけを担う。UI から
 * infra を直接触らず、ノート切替時は親の key で作り直す。filePaths 変更は再生成せず更新して
 * 巻き戻りを防ぐ。
 */

import { useEffect, useRef, type JSX } from 'react';

import { createEditorView, type EditorHandle } from '@/composition';

export type NoteEditorProps = {
  /** ノートパス（アクセシビリティラベル用。内容の再生成は親の key が担う） */
  notePath: string;
  /** エディタに初期表示するノート本文 */
  initialContent: string;
  /** Vault 内の全ファイルパス（WikiLink / Embed / Tag 装飾とクリック遷移に使う） */
  filePaths?: readonly string[];
  /** WikiLink クリック時の遷移コールバック（解決済みパス + 見出し。null は見出しなし） */
  onWikilinkClick?: (path: string, subpath: string | null) => void;
  /** 画像のペースト/ドロップ時のアップロード（成功で Vault 内パス、失敗は null） */
  onUploadImage?: (file: File) => Promise<string | null>;
  /** 本文が変わるたびに呼ばれる（未保存判定・Draft 退避のトリガー） */
  onContentChange?: (content: string) => void;
  /** エディタからのフォーカス喪失（自動保存のトリガー） */
  onBlur?: () => void;
  /** エディタ生成時（handle）/ 破棄時（null）に呼ばれる */
  onReady?: (handle: EditorHandle | null) => void;
};

export function NoteEditor({
  notePath,
  initialContent,
  filePaths,
  onWikilinkClick,
  onUploadImage,
  onContentChange,
  onBlur,
  onReady,
}: NoteEditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<EditorHandle | null>(null);

  // コールバックは ref で常に最新を参照する（エディタの再生成を避ける）
  const callbacksRef = useRef({ onContentChange, onBlur, onWikilinkClick, onUploadImage });
  callbacksRef.current = { onContentChange, onBlur, onWikilinkClick, onUploadImage };
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  // filePaths は生成時の最新値を使い、以降の変更は updateFilePaths が担う。
  // 依存配列に入れるとエディタが再生成されて編集中の本文が巻き戻るため ref で参照する
  const filePathsRef = useRef(filePaths);
  filePathsRef.current = filePaths;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const handle = createEditorView(container, initialContent, {
      filePaths: filePathsRef.current,
      onWikilinkClick: (path, subpath) => callbacksRef.current.onWikilinkClick?.(path, subpath),
      onUploadImage: (file) => {
        const upload = callbacksRef.current.onUploadImage;
        return upload ? upload(file) : Promise.resolve(null);
      },
    });
    handleRef.current = handle;
    handle.onChange((content) => callbacksRef.current.onContentChange?.(content));
    handle.onBlur(() => callbacksRef.current.onBlur?.());
    onReadyRef.current?.(handle);
    return (): void => {
      handle.destroy();
      handleRef.current = null;
      onReadyRef.current?.(null);
    };
  }, [initialContent]);

  // filePaths の変更は再生成せず装飾を更新する（画像アップロード後の Embed 解決）
  useEffect(() => {
    handleRef.current?.updateFilePaths(filePaths ?? []);
  }, [filePaths]);

  return (
    <div
      ref={containerRef}
      className="note-editor"
      data-testid="note-editor"
      aria-label={`ノート ${notePath} のエディタ`}
    />
  );
}
