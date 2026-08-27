/**
 * エディタ上部のインラインタイトル（通常はボタン表示、クリックでインライン入力）。
 * キー操作・blur の判断（確定 / キャンセル）は親が担い、このコンポーネントは
 * 入力の見た目とイベントの橋渡しだけを持つ。
 */

import { useEffect, useRef, type JSX, type KeyboardEvent } from 'react';

export type InlineTitleAreaProps = {
  /** 確定済みのタイトル（拡張子なし） */
  titleName: string;
  editing: boolean;
  titleDraft: string;
  titleError: string | null;
  onEditStart: () => void;
  onDraftChange: (draft: string) => void;
  /** 入力内のキー操作（Enter 確定 / Escape キャンセル） */
  handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** blur 時の確定（親側で「編集中のみ」というガードを持つ） */
  handleBlur: () => void;
  /** エディタ blur の自動保存を抑制する（タイトル編集へのクリック移動中） */
  onSuppressBlur: () => void;
};

export function InlineTitleArea(props: InlineTitleAreaProps): JSX.Element {
  const {
    titleName,
    editing,
    titleDraft,
    titleError,
    onEditStart,
    onDraftChange,
    handleKeyDown,
    handleBlur,
    onSuppressBlur,
  } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 編集モードへ切り替えたら入力へフォーカスする
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
    }
  }, [editing]);

  if (!editing) {
    return (
      <button
        type="button"
        className="editor-inline-title"
        data-testid="editor-title"
        onClick={onEditStart}
        aria-label="タイトルを編集"
        onPointerDown={onSuppressBlur}
      >
        {titleName}
      </button>
    );
  }
  return (
    <div
      className="editor-inline-title-edit"
      onPointerDown={() => {
        onSuppressBlur();
      }}
    >
      <input
        ref={inputRef}
        type="text"
        className="editor-inline-title-input"
        data-testid="editor-title-input"
        aria-label="ノートのタイトル"
        value={titleDraft}
        autoFocus
        onChange={(event) => {
          onDraftChange(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      />
      {titleError !== null && (
        <p className="file-tree-editor-error" role="alert">
          {titleError}
        </p>
      )}
    </div>
  );
}
