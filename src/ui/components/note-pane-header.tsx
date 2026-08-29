/**
 * ノートペインのヘッダー（パス表示 / 表示モード切替 / 保存状態 / 保存ボタン）。
 */

import type { JSX } from 'react';

import type { PaneMode, SaveStatus } from '@/ui/components/use-note-pane-core';

export type NotePaneHeaderProps = {
  notePath: string;
  mode: PaneMode;
  setMode: (mode: PaneMode) => void;
  /** 未確定（未コミット）の新規ノートか */
  isPending: boolean;
  saveStatus: SaveStatus;
  /** 保存時の競合（ConflictPanel 表示中。ボタン無効化の対象） */
  conflictActive: boolean;
  /** 同期衝突の表示中（ラベルのみに影響する） */
  syncConflictShown: boolean;
  loadReady: boolean;
  onSave: () => void;
};

export function NotePaneHeader(props: NotePaneHeaderProps): JSX.Element {
  const { notePath, mode, setMode, isPending, saveStatus, conflictActive, loadReady } = props;
  const status: { label: string; key: string } = ((): { label: string; key: string } => {
    if (isPending) {
      return saveStatus === 'saving'
        ? { label: '作成中…', key: 'saving' }
        : { label: '未保存', key: 'dirty' };
    }
    if (props.conflictActive || props.syncConflictShown) {
      return { label: '競合', key: 'conflict' };
    }
    if (saveStatus === 'saving') {
      return { label: '保存中…', key: 'saving' };
    }
    if (saveStatus === 'dirty') {
      return { label: '未保存', key: 'dirty' };
    }
    return { label: '保存済み', key: 'clean' };
  })();
  const disabledByConflict = !loadReady || conflictActive;
  return (
    <header className="note-pane-header">
      <p className="note-pane-path" data-testid="note-path">
        {notePath}
      </p>
      <div className="note-mode-toggle" role="group" aria-label="ノートの表示モード">
        <button
          type="button"
          className={mode === 'read' ? 'is-active' : ''}
          data-testid="mode-read-button"
          aria-pressed={mode === 'read'}
          onClick={() => setMode('read')}
          disabled={disabledByConflict || isPending}
        >
          表示
        </button>
        <button
          type="button"
          className={mode === 'edit' ? 'is-active' : ''}
          data-testid="mode-edit-button"
          aria-pressed={mode === 'edit'}
          onClick={() => setMode('edit')}
          disabled={disabledByConflict}
        >
          編集
        </button>
      </div>
      <span className="save-status" data-testid="save-status" data-status={status.key}>
        {status.label}
      </span>
      <button
        type="button"
        className="button-secondary note-save-button"
        data-testid="save-button"
        onClick={() => props.onSave()}
        disabled={saveStatus === 'saving' || conflictActive || !loadReady}
      >
        {isPending
          ? saveStatus === 'saving'
            ? '作成中…'
            : '作成'
          : saveStatus === 'saving'
            ? '保存中…'
            : '保存'}
      </button>
    </header>
  );
}
