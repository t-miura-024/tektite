/**
 * ファイルツリー上部の操作バー（新規ノート / 新規フォルダー / 検索 / 移動 /
 * 現在地表示 / 全展開・折りたたみ）。
 */

import type { JSX } from 'react';

import { ActionIcon } from '@/ui/components/file-tree-icons';

export type FileTreeToolbarProps = {
  onCreateNote: () => void;
  onOpenCreateForm: () => void;
  onOpenSearch?: () => void;
  onOpenQuickSwitcher?: () => void;
  onRevealCurrent?: () => void;
  onToggleAll?: () => void;
  allExpanded?: boolean;
  /** 現在のNoteを表示ボタンの無効化（未選択のとき true） */
  revealDisabled: boolean;
};

export function FileTreeToolbar({
  onCreateNote,
  onOpenCreateForm,
  onOpenSearch,
  onOpenQuickSwitcher,
  onRevealCurrent,
  onToggleAll,
  allExpanded = false,
  revealDisabled,
}: FileTreeToolbarProps): JSX.Element {
  return (
    <div className="file-tree-toolbar">
      <button
        type="button"
        className="button-secondary"
        data-testid="file-create-note-button"
        aria-label="新規ノート"
        title="新規ノート"
        onClick={onCreateNote}
      >
        <ActionIcon name="file-plus" />
      </button>
      <button
        type="button"
        className="button-secondary"
        data-testid="file-create-directory-button"
        aria-label="新規フォルダー"
        title="新規フォルダー"
        onClick={onOpenCreateForm}
      >
        <ActionIcon name="folder-plus" />
      </button>
      <button
        type="button"
        className="button-secondary file-tree-action-button"
        aria-label="検索"
        title="検索 ⌘K"
        onClick={() => onOpenSearch?.()}
      >
        <ActionIcon name="search" />
      </button>
      <button
        type="button"
        className="button-secondary file-tree-action-button"
        aria-label="移動"
        title="移動 ⌘O"
        onClick={() => onOpenQuickSwitcher?.()}
      >
        <ActionIcon name="switcher" />
      </button>
      <button
        type="button"
        className="button-secondary file-tree-action-button"
        aria-label="現在のNoteを表示"
        title="現在のNoteを表示"
        disabled={revealDisabled}
        onClick={() => onRevealCurrent?.()}
      >
        <ActionIcon name="locate" />
      </button>
      <button
        type="button"
        className="button-secondary file-tree-action-button"
        aria-label={allExpanded ? 'すべて折りたたむ' : 'すべて展開'}
        title={allExpanded ? 'すべて折りたたむ' : 'すべて展開'}
        aria-pressed={allExpanded}
        onClick={() => onToggleAll?.()}
      >
        <ActionIcon name={allExpanded ? 'collapse' : 'expand'} />
      </button>
    </div>
  );
}
