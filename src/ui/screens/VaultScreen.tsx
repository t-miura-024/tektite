/**
 * Vault 内画面（`/:owner/:repo` と `/:owner/:repo/blob/:path` の共通シェル）。
 *
 * - サイドバー: デフォルトブランチのファイルツリー（ディレクトリ開閉・ファイル選択）
 * - メインペイン: 選択中のノート（表示実装は次計画のためプレースホルダ）
 *
 * ディープリンク対応: ツリーは URL のみから復元する。ノートパス付き URL で
 * 開いた場合は、そのファイルまでの祖先ディレクトリを自動展開して選択状態を
 * 復元する。レスポンシブ: 狭い画面ではツリーを上部、ノートを下部に縦積みする。
 */

import { useCallback, useEffect, useState } from 'react';

import type { VaultUseCases } from '@/application/vault';
import type { VaultTree } from '@/domain/tree';
import { ancestorDirectoryPaths } from '@/domain/tree';
import type { VaultRef } from '@/domain/vault';
import { vaultRefFullName } from '@/domain/vault';

import { FileTree } from '../components/FileTree';
import { Link } from '../components/Link';
import type { ToastAction } from '../toast';
import { isSessionExpiredError, vaultErrorMessage } from '../vault-error';

export interface VaultScreenProps {
  vaultRef: VaultRef;
  /** 選択中のノートパス（ツリー画面では null） */
  notePath: string | null;
  useCases: VaultUseCases;
  notify: (message: string, action?: ToastAction) => void;
  onSessionExpired: () => void;
}

type TreeState =
  | { kind: 'loading' }
  | { kind: 'ready'; tree: VaultTree }
  | { kind: 'error'; message: string };

export function VaultScreen({
  vaultRef,
  notePath,
  useCases,
  notify,
  onSessionExpired,
}: VaultScreenProps) {
  const [state, setState] = useState<TreeState>({ kind: 'loading' });
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set(['']));

  // オブジェクトの同一性ではなく値（owner / name）で依存を比較する
  // （ツリー ↔ ノートのルーティング往来で再取得しないため）
  const { owner, name } = vaultRef;

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const tree = await useCases.openVault({ owner, name });
      setState({ kind: 'ready', tree });
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
  }, [useCases, owner, name, notify, onSessionExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  // Vault が変わったら展開状態をリセットする
  useEffect(() => {
    setExpandedPaths(new Set(['']));
  }, [owner, name]);

  // ツリー取得後: ルートを展開し、ノートパス指定があれば祖先ディレクトリも展開する
  // （ディープリンクのリロードで選択状態を復元するため）
  useEffect(() => {
    if (state.kind !== 'ready') {
      return;
    }
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      next.add('');
      if (notePath) {
        for (const ancestor of ancestorDirectoryPaths(notePath)) {
          next.add(ancestor);
        }
      }
      return next;
    });
  }, [state, notePath]);

  const toggleDirectory = useCallback((path: string) => {
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  return (
    <div className="vault-screen">
      <aside className="vault-sidebar">
        <div className="vault-sidebar-header">
          <Link to="/" className="vault-back-link">
            ← Vault 一覧
          </Link>
          <h2 className="vault-title">{vaultRefFullName(vaultRef)}</h2>
        </div>
        {state.kind === 'loading' && (
          <p className="app-placeholder" role="status">
            ツリーを読み込み中…
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
        {state.kind === 'ready' && (
          <>
            <p className="vault-branch">ブランチ: {state.tree.defaultBranch}</p>
            {state.tree.truncated && (
              <p className="tree-truncated-notice">
                リポジトリが大きいため、一部のファイルのみ表示しています。
              </p>
            )}
            <FileTree
              root={state.tree.root}
              vaultRef={vaultRef}
              expandedPaths={expandedPaths}
              selectedPath={notePath}
              onToggleDirectory={toggleDirectory}
            />
          </>
        )}
      </aside>
      <section className="vault-content">
        {notePath !== null ? (
          <div className="note-pane">
            <p className="note-pane-label">ノート</p>
            <p className="note-pane-path" data-testid="note-path">
              {notePath}
            </p>
            <p className="app-placeholder">ノートの表示は次の計画で実装されます。</p>
          </div>
        ) : (
          <p className="app-placeholder">ツリーからファイルを選択してください。</p>
        )}
      </section>
    </div>
  );
}
