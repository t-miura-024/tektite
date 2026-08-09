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
 * ノート索引（全ノートの本文 + sha）は application 層の共有レジストリ
 * （note-index.ts）に展開され、タグ一覧・バックリンク・検索（M2 以降）が
 * 同一インスタンスを参照する。保存後の更新は NotePane の onNoteSaved 経由で
 * レジストリへ反映する。
 *
 * ユースケースの実行は組成ルート（src/composition）の run() 経由で行う。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { applySavedNote, loadNoteIndex } from '@/application/note-index';
import type { NoteIndex } from '@/application/note-index';
import { createNoteSearcher } from '@/application/search';
import type { NoteSearcher, SearchableNote } from '@/application/search';
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
import { SearchPanel } from '@/ui/components/SearchPanel';
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
   * 共有メモリ索引（Vault の全ノート本文 + sha）。ツリー取得成功後に application 層の
   * レジストリ（note-index.ts）から取得する。同じ Vault への再入場ではレジストリが
   * 再取得を防ぐ（GitHub のレートリミット圧迫を避けるため）。リロード時はメモリが
   * 消えるため再取得される。保存による最新化は NotePane の onNoteSaved 経由で
   * レジストリへ反映し、この state も更新する。
   */
  const [noteIndex, setNoteIndex] = useState<NoteIndex | null>(null);
  /** 全文検索パネルの開閉（Cmd+K / Ctrl+K と検索ボタンから操作する） */
  const [searchOpen, setSearchOpen] = useState(false);

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
      return;
    }
    // ツリー取得成功後、全ノートを共有索引へ展開する。索引の失敗はツリー表示を
    // 妨げない（タグ一覧・バックリンクが非表示になるだけ）。既に展開済みの Vault は
    // レジストリが再取得せず同じ索引を返す
    try {
      const index = await run(loadNoteIndex({ owner, name }));
      setNoteIndex(index);
    } catch {
      notify('ノート索引を取得できませんでした。タグ・バックリンクは表示されません。');
    }
  }, [owner, name, notify, onSessionExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  // 共有索引からバックリンク / タグ索引を構築する（検索・クイックスイッチャーは
  // 同じ noteIndex を参照する。M2 / M3 のスコープ）。ツリーのファイル一覧は
  // WikiLink 解決（画像含む）のため tree.ts と整合させた全体を使う
  const notation = useMemo<VaultNotationIndex | null>(() => {
    if (noteIndex === null || state.kind !== 'ready') {
      return null;
    }
    const filePaths = collectFilePaths(state.tree.root);
    const contents = new Map<string, string>();
    for (const note of noteIndex.notes.values()) {
      contents.set(note.path, note.content);
    }
    return buildNotationIndex({ filePaths, contents });
  }, [noteIndex, state]);

  // 全文検索器: 共有索引（本文 + パス）と記法索引（タグ）を統合して構築する。
  // ノート索引の更新（保存反映・再ロード）のたびに再構築される（M2）
  const searcher = useMemo<NoteSearcher | null>(() => {
    if (noteIndex === null || notation === null) {
      return null;
    }
    const notes: SearchableNote[] = [];
    for (const note of noteIndex.notes.values()) {
      notes.push({
        path: note.path,
        content: note.content,
        tags: notation.notes.get(note.path)?.tags ?? [],
      });
    }
    return createNoteSearcher(notes);
  }, [noteIndex, notation]);

  // Cmd+K / Ctrl+K: 全文検索パネルの開閉（M2。Cmd+S とは衝突しない）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /**
   * ノート保存後に共有索引とバックリンク / タグ索引を更新する。保存済みの本文を
   * 渡すため、再取得は発生しない（レートリミット圧迫の回避）。レジストリの索引は
   * applySaved が更新し、state も同じインスタンスへ置き換えて再レンダリングする。
   */
  const handleNoteSaved = useCallback(
    (path: string, content: string): void => {
      void run(applySavedNote({ owner, name }, path, content)).then((index) => {
        if (index !== null) {
          setNoteIndex(index);
        }
      });
    },
    [owner, name],
  );

  // Vault が変わったら索引と展開状態をリセットする（新しい Vault のロード中に
  // 前の Vault のタグ・バックリンクを表示しない）
  useEffect(() => {
    setNoteIndex(null);
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
          <button
            type="button"
            className="button-secondary search-open-button"
            onClick={() => setSearchOpen(true)}
          >
            検索 <span className="search-open-shortcut">⌘K</span>
          </button>
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
            onNoteSaved={handleNoteSaved}
          />
        ) : (
          <p className="app-placeholder">ツリーからファイルを選択してください。</p>
        )}
      </section>
      {searchOpen && (
        <SearchPanel vaultRef={vaultRef} searcher={searcher} onClose={() => setSearchOpen(false)} />
      )}
    </div>
  );
}
