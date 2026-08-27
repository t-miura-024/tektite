/**
 * ノート系エラーの表示メッセージ変換（UI 層のプレゼンテーション判断）。
 * エラー UX 基本方針: トースト表示 + リトライ導線。
 * Vault 系（src/ui/vault-error）と同じ kind 合併型を扱う。
 */

import {
  isFileCommitError,
  isNoteFetchError,
  isNoteSaveError,
  type FileCommitErrorKind,
  type NoteFetchErrorKind,
  type NoteSaveErrorKind,
} from '@/application/note';
import { vaultErrorMessage } from '@/ui/vault-error';

/** 取得エラー（server 以外）のメッセージテーブル */
const FETCH_MESSAGES: Record<Exclude<NoteFetchErrorKind, 'server'>, string> = {
  unauthenticated: 'セッションの有効期限が切れました。ログインし直してください。',
  rate_limited: 'GitHub API のレートリミットに達しました。しばらくしてから再試行してください。',
  not_found: 'ノートが見つかりませんでした。',
  network: 'サーバーと通信できませんでした。接続を確認してください。',
};

export function noteErrorMessage(error: unknown): string {
  if (isNoteFetchError(error)) {
    return error.kind === 'server' ? error.message : FETCH_MESSAGES[error.kind];
  }
  return vaultErrorMessage(error);
}

/** 保存エラーの表示メッセージ変換（conflict は ConflictPanel が担うため通常トーストには出ない） */
export function noteSaveErrorMessage(error: unknown): string {
  if (isNoteSaveError(error)) {
    if (error.kind === 'server') {
      return error.message;
    }
    const messages: Record<Exclude<NoteSaveErrorKind, 'server'>, string> = {
      unauthenticated: FETCH_MESSAGES.unauthenticated,
      rate_limited: FETCH_MESSAGES.rate_limited,
      conflict: '保存できませんでした。リモートの内容が変更されています。',
      not_found: 'ノートが見つからないため保存できませんでした。',
      network: FETCH_MESSAGES.network,
    };
    return messages[error.kind];
  }
  return noteErrorMessage(error);
}

/** ファイル操作（作成/リネーム/移動/削除）エラーの表示メッセージ変換 */
export function fileErrorMessage(error: unknown): string {
  if (isFileCommitError(error)) {
    if (error.kind === 'server') {
      return error.message;
    }
    const messages: Record<Exclude<FileCommitErrorKind, 'server'>, string> = {
      unauthenticated: FETCH_MESSAGES.unauthenticated,
      rate_limited: FETCH_MESSAGES.rate_limited,
      conflict: '操作できませんでした。リモートの内容が変更されています。再読み込みしてください。',
      not_found: '対象が見つからないため操作できませんでした。',
      network: FETCH_MESSAGES.network,
    };
    return messages[error.kind];
  }
  return noteErrorMessage(error);
}
