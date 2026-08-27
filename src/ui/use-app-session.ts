/**
 * アプリ全体のセッション状態（ログイン判定とログアウト）を担うフック。
 *
 * - loading: 初回のセッション確認中
 * - anonymous: 未ログイン（LoginScreen を出す）
 * - authenticated: ログイン済み（ルートに応じた画面を出す）
 * - error: セッション確認自体の失敗（表示 + 再試行）
 */

import { useCallback, useState } from 'react';

import {
  getCurrentSession,
  isSessionFetchError,
  logout,
  type SessionUser,
} from '@/application/session';
import { run } from '@/composition';

export type SessionPhase =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; user: SessionUser }
  | { kind: 'error'; message: string };

export type AppSession = {
  phase: SessionPhase;
  /** セッション状態を再確認する（初回マウント・再試行・失効時） */
  checkSession: () => Promise<void>;
  /** ログアウトを実行する（実行中は loggingOut が true） */
  handleLogout: () => Promise<void>;
  loggingOut: boolean;
};

export function useAppSession(onNotifyError: (message: string) => void): AppSession {
  const [phase, setPhase] = useState<SessionPhase>({ kind: 'loading' });
  const [loggingOut, setLoggingOut] = useState(false);

  const checkSession = useCallback(async (): Promise<void> => {
    setPhase({ kind: 'loading' });
    try {
      const session = await run(getCurrentSession);
      if (session.status === 'authenticated') {
        setPhase({ kind: 'authenticated', user: session.user });
        return;
      }
      setPhase({ kind: 'anonymous' });
    } catch (error) {
      const message = isSessionFetchError(error)
        ? error.message
        : 'セッションの確認に失敗しました。';
      setPhase({ kind: 'error', message });
    }
  }, []);

  const handleLogout = useCallback(async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await run(logout);
      setPhase({ kind: 'anonymous' });
    } catch (error) {
      const message = isSessionFetchError(error) ? error.message : 'ログアウトに失敗しました。';
      onNotifyError(`${message} 時間をおいてやり直してください。`);
    } finally {
      setLoggingOut(false);
    }
  }, [onNotifyError]);

  return { phase, checkSession, handleLogout, loggingOut };
}
