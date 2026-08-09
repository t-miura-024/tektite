/**
 * 確認ダイアログ（M5: 削除などの不可逆操作の前に挟む）。
 *
 * 削除は GitHub 上の実削除で取り消せない（ゴミ箱は作らない方針）ため、
 * 実行前に必ずこのダイアログで明示確認する。オーバーレイ + role="alertdialog"。
 */

import { useEffect, useRef } from 'react';

export interface ConfirmDialogProps {
  title: string;
  message: string;
  /** 確定ボタンのラベル（既定は「実行」） */
  confirmLabel?: string;
  /** 破壊的操作か（true で確定ボタンを危険色にする） */
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = '実行',
  danger = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // フォーカスをダイアログ内へ移し、Escape / Enter をダイアログ操作に割り当てる
  useEffect(() => {
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel, onConfirm]);

  return (
    <div className="dialog-overlay" data-testid="confirm-dialog">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h3 className="dialog-title" id="confirm-title">
          {title}
        </h3>
        <p className="dialog-message">{message}</p>
        <div className="dialog-actions">
          <button type="button" className="button-secondary" onClick={onCancel}>
            キャンセル
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={danger ? 'button-danger' : 'button-primary'}
            data-testid="confirm-dialog-confirm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
