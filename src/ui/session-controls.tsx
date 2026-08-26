/**
 * 認証済みヘッダーのセッション操作領域（ログイン中表示 + ログアウトボタン）。
 */

import type { JSX } from 'react';

export type SessionControlsProps = {
  /** ログイン中のユーザー ID（GitHub login） */
  login: string;
  loggingOut: boolean;
  onLogout: () => void;
};

export function SessionControls({
  login,
  loggingOut,
  onLogout,
}: SessionControlsProps): JSX.Element {
  return (
    <div className="session-controls">
      <span className="session-login">{login} でログイン中</span>
      <button type="button" className="button-secondary" onClick={onLogout} disabled={loggingOut}>
        {loggingOut ? 'ログアウト中…' : 'ログアウト'}
      </button>
    </div>
  );
}
