/**
 * トースト通知（エラー UX 基盤: トースト表示 + リトライ導線）。
 * role="alert" でスクリーンリーダーにも即座に伝わるようにする。
 */

export interface ToastProps {
  message: string;
  onDismiss: () => void;
  /** リトライ導線（任意） */
  action?: { label: string; onClick: () => void };
}

export function Toast({ message, onDismiss, action }: ToastProps) {
  return (
    <div className="toast" role="alert">
      <p className="toast-message">{message}</p>
      <div className="toast-actions">
        {action && (
          <button type="button" className="button-secondary toast-action" onClick={action.onClick}>
            {action.label}
          </button>
        )}
        <button type="button" className="button-secondary toast-dismiss" onClick={onDismiss}>
          閉じる
        </button>
      </div>
    </div>
  );
}
