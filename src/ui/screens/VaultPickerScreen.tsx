/**
 * Vault 選択画面（ルート `/`、ログイン後の既定表示）。
 *
 * ログインユーザーのリポジトリ一覧（Vault 候補）を表示し、
 * 選択した Vault のファイルツリー画面（/:owner/:repo）へ SPA 遷移する。
 *
 * エラー UX 基本方針: トースト表示 + リトライ。コンテンツ側にも
 * リトライ導線を出し、トーストを閉じても再試行できるようにする。
 */

import { useCallback, useEffect, useState } from 'react';

import type { VaultUseCases } from '@/application/vault';
import type { Vault } from '@/domain/vault';
import { vaultRefFullName } from '@/domain/vault';

import { Link } from '../components/Link';
import { vaultRoutePath } from '../router';
import type { ToastAction } from '../toast';
import { isSessionExpiredError, vaultErrorMessage } from '../vault-error';

export interface VaultPickerScreenProps {
  useCases: VaultUseCases;
  notify: (message: string, action?: ToastAction) => void;
  /** セッション失効（401）時にログイン状態の再確認を依頼する */
  onSessionExpired: () => void;
}

type PickerState =
  | { kind: 'loading' }
  | { kind: 'ready'; vaults: readonly Vault[] }
  | { kind: 'error'; message: string };

export function VaultPickerScreen({ useCases, notify, onSessionExpired }: VaultPickerScreenProps) {
  const [state, setState] = useState<PickerState>({ kind: 'loading' });

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const vaults = await useCases.listVaults();
      setState({ kind: 'ready', vaults });
    } catch (error) {
      if (isSessionExpiredError(error)) {
        notify('セッションの有効期限が切れました。ログインし直してください。');
        onSessionExpired();
        return;
      }
      const message = vaultErrorMessage(error);
      setState({ kind: 'error', message });
      notify(message, { label: '再試行', onClick: () => void load() });
    }
  }, [useCases, notify, onSessionExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="vault-picker">
      <h2 className="vault-picker-title">Vault を開く</h2>
      {state.kind === 'loading' && (
        <p className="app-placeholder" role="status">
          Vault 一覧を読み込み中…
        </p>
      )}
      {state.kind === 'error' && (
        <div className="error-panel">
          <p>{state.message}</p>
          <button type="button" className="button-secondary" onClick={() => void load()}>
            再試行
          </button>
        </div>
      )}
      {state.kind === 'ready' && state.vaults.length === 0 && (
        <p className="app-placeholder">Vault として使えるリポジトリがありません。</p>
      )}
      {state.kind === 'ready' && state.vaults.length > 0 && (
        <ul className="vault-list">
          {state.vaults.map((vault) => (
            <li key={vault.fullName} className="vault-list-item">
              <Link to={vaultRoutePath(vault)} className="vault-link">
                <span className="vault-name">{vaultRefFullName(vault)}</span>
                {vault.isPrivate && <span className="vault-badge">非公開</span>}
                {vault.description !== null && vault.description !== '' && (
                  <span className="vault-description">{vault.description}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
