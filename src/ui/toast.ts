/**
 * トースト通知の共有型。
 * Toast コンポーネント（components/Toast）と、トースト表示を要求する
 * 各画面（エラー UX 基本方針: トースト表示 + リトライ導線）で使う。
 */

export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ToastState {
  readonly message: string;
  readonly action?: ToastAction;
}
