/**
 * Vault 系エラーの表示メッセージ変換（UI 層のプレゼンテーション判断）。
 * エラー UX 基本方針: トースト表示 + リトライ導線。
 */

import { isFileCommitError, isNoteFetchError, isNoteSaveError } from '@/application/note';
import { isVaultFetchError, type VaultFetchErrorKind } from '@/application/vault';

/** Vault 取得エラー（server 以外）のメッセージテーブル */
const VAULT_FETCH_MESSAGES: Record<Exclude<VaultFetchErrorKind, 'server'>, string> = {
  unauthenticated: 'セッションの有効期限が切れました。ログインし直してください。',
  rate_limited: 'GitHub API のレートリミットに達しました。しばらくしてから再試行してください。',
  not_found: 'Vault が見つかりませんでした。',
  network: 'サーバーと通信できませんでした。接続を確認してください。',
};

export function vaultErrorMessage(error: unknown): string {
  if (isVaultFetchError(error)) {
    return error.kind === 'server' ? error.message : VAULT_FETCH_MESSAGES[error.kind];
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
    (isVaultFetchError(error) ||
      isNoteFetchError(error) ||
      isNoteSaveError(error) ||
      isFileCommitError(error)) &&
    error.kind === 'unauthenticated'
  );
}
