/**
 * 同期中オーバーレイ（初期同期・明示同期の進捗表示）。
 * 表示中はフォーカスを自身へ移し、背後のエディタ編集をブロックする。
 */

import { useEffect, useRef, type JSX } from 'react';

import type { SyncProgress } from '@/application/vault';

export type SyncOverlayProps = {
  /** 初期同期か（文言と進捗の有無に出る） */
  initializing: boolean;
  progress: SyncProgress | null;
};

export function SyncOverlay({ initializing, progress }: SyncOverlayProps): JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null);

  // マウント時にオーバーレイへフォーカスを移してキー入力を追い出す
  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  return (
    <div
      ref={overlayRef}
      className="sync-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="同期中"
      aria-busy="true"
      tabIndex={-1}
      data-testid="sync-overlay"
    >
      <div className="sync-overlay-panel">
        <div className="sync-spinner" aria-hidden="true" />
        <p className="sync-overlay-title">
          {initializing ? 'Vault を初期同期しています…' : 'Vault を同期しています…'}
        </p>
        {progress !== null && (
          <p className="sync-overlay-progress" data-testid="sync-progress">
            {Math.round(progress.fraction * 100)}%
            {progress.remaining > 0 ? `（残り約 ${progress.remaining} 件）` : ''}
          </p>
        )}
      </div>
    </div>
  );
}
