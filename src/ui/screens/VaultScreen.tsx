/**
 * Vault 内画面（`/:owner/:repo` と `/:owner/:repo/blob/:path` の共通シェル）。
 *
 * - サイドバー: デフォルトブランチのファイルツリー（ディレクトリ開閉・ファイル選択）
 * - メインペイン: 選択中のノート（CM6 エディタ。ノート未選択はプレースホルダ）
 *
 * ディープリンク対応: ツリーは URL のみから復元する。ノートパス付き URL で
 * 開いた場合は、そのファイルまでの祖先ディレクトリを自動展開して選択状態を
 * 復元する。レスポンシブ: 狭い画面ではツリーを上部、ノートを下部に縦積みする。
 *
 * ユースケースの実行は組成ルート（src/composition）の run() 経由で行う。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { openNote } from '@/application/note';
import { openVault } from '@/application/vault';
import { run } from '@/composition';
import { buildNotationIndex } from '@/domain/notation/index';
import type { VaultNotationIndex } from '@/domain/notation/index';
import type { TreeDirectory, VaultTree } from '@/domain/tree';
import { ancestorDirectoryPaths } from '@/domain/tree';
import type { VaultRef } from '@/domain/vault';
import { vaultRefFullName } from '@/domain/vault';

import { BacklinkPanel } from '@/ui/components/BacklinkPanel';
import { FileTree } from '@/ui/components/FileTree';
import { Link } from '@/ui/components/Link';
import { NotePane } from '@/ui/components/NotePane';
import { TagPanel } from '@/ui/components/TagPanel';
import type { ToastAction } from '@/ui/toast';
import { isSessionExpiredError, vaultErrorMessage } from '@/ui/vault-error';

/** ツリーから全ファイルパスを収集する（リーディング表示のリンク解決用） */
function collectFilePaths(root: TreeDirectory): string[] {
  const paths: string[] = [];
  const walk = (directory: TreeDirectory): void => {
    for (const child of directory.children) {
      if (child.type === 'file') {
        paths.push(child.path);
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  return paths;
}

export interface VaultScreenProps {
  vaultRef: VaultRef;
  /** 選択中のノートパス（ツリー画面では null） */
  notePath: string | null;
  notify: (message: string, action?: ToastAction) => void;
  onSessionExpired: () => void;
}

type TreeState =
  | { kind: 'loading' }
  | { kind: 'ready'; tree: VaultTree }
  | { kind: 'error'; message: string };

export function VaultScreen({ vaultRef, notePath, notify, onSessionExpired }: VaultScreenProps) {
  const [state, setState] = useState<TreeState>({ kind: 'loading' });
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set(['']));
  /**
   * 記法索引（バックリンク / タグ一覧用）。ツリー取得後に全 Markdown ノートの
   * 本文を取得して構築する。編集保存後の最新状態を反映するため、ノート切替時
   * （notePath 変更）にも再構築する（MVP: Vault が小さい前提で全件取得）
   */
  const [notation, setNotation] = useState<VaultNotationIndex | null>(null);

  // オブジェクトの同一性ではなく値（owner / name）で依存を比較する
  // （ツリー ↔ ノートのルーティング往来で再取得しないため）
  const { owner, name } = vaultRef;

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const tree = await run(openVault({ owner, name }));
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
  }, [owner, name, notify, onSessionExpired]);

  /**
   * ツリーから記法索引を構築する。取得できないノート（404 等）は索引から
   * 欠落させる（バックリンク / タグ表示が不完全になるだけで画面は継続する）。
   */
  const loadNotationIndex = useCallback(
    async (tree: VaultTree): Promise<VaultNotationIndex> => {
      const filePaths = collectFilePaths(tree.root);
      const contents = new Map<string, string>();
      const notePaths = filePaths.filter((path) => path.endsWith('.md'));
      await Promise.all(
        notePaths.map(async (path) => {
          try {
            const note = await run(openNote({ owner, name }, path));
            contents.set(path, note.content);
          } catch {
            // 個別ノートの取得失敗は索引から欠落させる
          }
        }),
      );
      return buildNotationIndex({ filePaths, contents });
    },
    [owner, name],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // ツリー取得後・ノート切替時に記法索引を再構築する（ノート切替時は保存後の
  // 最新状態を反映するため）
  useEffect(() => {
    if (state.kind !== 'ready') {
      return;
    }
    let cancelled = false;
    void loadNotationIndex(state.tree).then((index) => {
      if (!cancelled) {
        setNotation(index);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [state, notePath, loadNotationIndex]);

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

  // ツリーが取得できている間だけ全ファイルパスを算出する（リーディング表示用）
  const filePaths = useMemo(
    () => (state.kind === 'ready' ? collectFilePaths(state.tree.root) : []),
    [state],
  );

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
        {notation !== null && (
          <section className="vault-sidebar-section" aria-label="タグ一覧">
            <h3 className="vault-sidebar-section-title">タグ</h3>
            <TagPanel vaultRef={vaultRef} tagIndex={notation.tagIndex} notes={notation.notes} />
          </section>
        )}
        {notation !== null && notePath !== null && (
          <section className="vault-sidebar-section" aria-label="バックリンク">
            <h3 className="vault-sidebar-section-title">バックリンク</h3>
            <BacklinkPanel vaultRef={vaultRef} links={notation.backlinks.get(notePath) ?? []} />
          </section>
        )}
      </aside>
      <section className="vault-content">
        {notePath !== null ? (
          <NotePane
            vaultRef={vaultRef}
            notePath={notePath}
            filePaths={filePaths}
            notify={notify}
            onSessionExpired={onSessionExpired}
          />
        ) : (
          <p className="app-placeholder">ツリーからファイルを選択してください。</p>
        )}
      </section>
    </div>
  );
}
