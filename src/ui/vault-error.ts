/**
 * Vault 系エラーの表示メッセージ変換（UI 層のプレゼンテーション判断）。
 * エラー UX 基本方針: トースト表示 + リトライ導線。
 */

import { FileCommitError, NoteFetchError, NoteSaveError } from '@/application/note';
import { VaultFetchError } from '@/application/vault';

export function vaultErrorMessage(error: unknown): string {
  if (error instanceof VaultFetchError) {
    switch (error.kind) {
      case 'unauthenticated':
        return 'セッションの有効期限が切れました。ログインし直してください。';
      case 'rate_limited':
        return 'GitHub API のレートリミットに達しました。しばらくしてから再試行してください。';
      case 'not_found':
        return 'Vault が見つかりませんでした。';
      case 'network':
        return 'サーバーと通信できませんでした。接続を確認してください。';
      case 'server':
        return error.message;
    }
  }
  return '予期しないエラーが発生しました。';
}

/**
 * セッション失効（401）かどうか。該当時はログイン画面へ戻す。
 * Vault 系・ノート取得系・ノート保存系・一括コミット系のエラー種別は同じ
 * kind 合併型を持つため、4 系統をまとめて判定する。
 */
export function isSessionExpiredError(error: unknown): boolean {
  return (
    (error instanceof VaultFetchError ||
      error instanceof NoteFetchError ||
      error instanceof NoteSaveError ||
      error instanceof FileCommitError) &&
    error.kind === 'unauthenticated'
  );
}
