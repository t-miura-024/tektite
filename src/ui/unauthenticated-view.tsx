/**
 * 未認証時のヘッダー下コンテンツ（読み込み中 / ログイン / エラー + 再試行）。
 */

import type { JSX } from 'react';

import { LoginScreen } from '@/ui/screens/login-screen';
import type { SessionPhase } from '@/ui/use-app-session';

export type UnauthenticatedViewProps = {
  phase: SessionPhase;
  onRetry: () => void;
};

export function UnauthenticatedView({ phase, onRetry }: UnauthenticatedViewProps): JSX.Element {
  return (
    <>
      {phase.kind === 'loading' && (
        <p className="app-placeholder" role="status">
          セッションを確認中…
        </p>
      )}
      {phase.kind === 'anonymous' && <LoginScreen />}
      {phase.kind === 'error' && (
        <section className="error-panel">
          <p role="alert">{phase.message}</p>
          <button type="button" className="button-secondary" onClick={onRetry}>
            再試行
          </button>
        </section>
      )}
    </>
  );
}
