/**
 * ノートペインの読み込み状態表示（読み込み中 / エラー + 再試行）。
 */

import type { JSX } from 'react';

import type { LoadState } from '@/ui/components/use-note-pane-core';

export type NotePaneStateViewsProps = {
  loadState: LoadState;
  onRetry: () => void;
};

export function NotePaneStateViews({ loadState, onRetry }: NotePaneStateViewsProps): JSX.Element {
  return (
    <>
      {loadState.kind === 'loading' && (
        <p className="app-placeholder" role="status">
          ノートを読み込み中…
        </p>
      )}
      {loadState.kind === 'error' && (
        <div className="error-panel">
          <p>{loadState.message}</p>
          <button type="button" className="button-secondary" onClick={onRetry}>
            再試行
          </button>
        </div>
      )}
    </>
  );
}
