/**
 * エラー表示 + 再試行ボタンの共通パネル。
 *
 * エラー UX 基本方針（トースト + リトライ導線）のうち、コンテンツ側に置く
 * リトライ導線の見た目を統一する（Vault 一覧・ツリー・ノート・リーディング表示で共用）。
 */

import type { JSX } from 'react';

export type ErrorRetryPanelProps = {
  /** 表示するエラーメッセージ */
  message: string;
  /** 再試行ボタン押下時に実行する */
  onRetry: () => void;
};

export function ErrorRetryPanel({ message, onRetry }: ErrorRetryPanelProps): JSX.Element {
  return (
    <div className="error-panel">
      <p>{message}</p>
      <button type="button" className="button-secondary" onClick={onRetry}>
        再試行
      </button>
    </div>
  );
}
