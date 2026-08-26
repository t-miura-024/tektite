/**
 * Draft 復元通知（「未保存の変更が復元されました」+ 復元 / 破棄）。
 */

import type { JSX } from 'react';

export type DraftRestoreBannerProps = {
  onRestore: () => void;
  onDiscard: () => void;
};

export function DraftRestoreBanner({ onRestore, onDiscard }: DraftRestoreBannerProps): JSX.Element {
  return (
    <div className="draft-restore" data-testid="draft-restore" role="status">
      <p className="draft-restore-message">未保存の変更が復元されました。</p>
      <div className="draft-restore-actions">
        <button
          type="button"
          className="button-primary"
          data-testid="draft-restore-button"
          onClick={onRestore}
        >
          復元
        </button>
        <button
          type="button"
          className="button-secondary"
          data-testid="draft-discard-button"
          onClick={onDiscard}
        >
          破棄
        </button>
      </div>
    </div>
  );
}
