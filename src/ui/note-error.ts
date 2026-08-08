/**
 * ノート系エラーの表示メッセージ変換（UI 層のプレゼンテーション判断）。
 * エラー UX 基本方針: トースト表示 + リトライ導線。
 * Vault 系（src/ui/vault-error）と同じ kind 合併型を扱う。
 */

import { NoteFetchError } from '@/application/note';
import { vaultErrorMessage } from '@/ui/vault-error';

export function noteErrorMessage(error: unknown): string {
  if (error instanceof NoteFetchError) {
    switch (error.kind) {
      case 'unauthenticated':
        return 'セッションの有効期限が切れました。ログインし直してください。';
      case 'rate_limited':
        return 'GitHub API のレートリミットに達しました。しばらくしてから再試行してください。';
      case 'not_found':
        return 'ノートが見つかりませんでした。';
      case 'network':
        return 'サーバーと通信できませんでした。接続を確認してください。';
      case 'server':
        return error.message;
    }
  }
  return vaultErrorMessage(error);
}
