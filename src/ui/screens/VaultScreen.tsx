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
import type { CSSProperties } from 'react';

import { applyFileOperation } from '@/application/file';
import type { FileOperation } from '@/application/file';
import { applySavedNote, loadNoteIndex } from '@/application/note-index';
import type { NoteIndex } from '@/application/note-index';
import { createNoteSearcher } from '@/application/search';
import type { NoteSearcher, SearchableNote } from '@/application/search';
import { openVault } from '@/application/vault';
import { run, slugify } from '@/composition';
import { buildNotationIndex } from '@/domain/notation/index';
import type { VaultNotationIndex } from '@/domain/notation/index';
import type { TreeDirectory, VaultTree } from '@/domain/tree';
import {
  ancestorDirectoryPaths,
  joinDirectoryPath,
  parentDirectoryPath,
  pathBaseName,
} from '@/domain/tree';
import type { VaultRef } from '@/domain/vault';
import { vaultRefFullName } from '@/domain/vault';

import { BacklinkPanel } from '@/ui/components/BacklinkPanel';
import { EmptyVaultCta } from '@/ui/components/EmptyVaultCta';
import { FileTree } from '@/ui/components/FileTree';
import { Link } from '@/ui/components/Link';
import { NotePane } from '@/ui/components/NotePane';
import { QuickSwitcher } from '@/ui/components/QuickSwitcher';
import { SearchPanel } from '@/ui/components/SearchPanel';
import { TagPanel } from '@/ui/components/TagPanel';
import { fileErrorMessage } from '@/ui/note-error';
import { navigate, noteRoutePath, vaultRoutePath } from '@/ui/router';
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

interface OutlineHeading {
  readonly level: number;
  readonly text: string;
  readonly slug: string;
}

function collectOutline(content: string): readonly OutlineHeading[] {
  return content.split('\n').flatMap((line) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match === null) {
      return [];
    }
    const text = match[2] ?? '';
    return [{ level: match[1]?.length ?? 1, text, slug: slugify(text) }];
  });
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
  /**
   * ノート索引の読み込み失敗メッセージ（null は成功 / 未実行）。
   * 失敗時は検索パネル・クイックスイッチャーが「読み込み中…」の代わりに
   * エラーと再試行導線を表示する（difit 指摘 5）。
   */
  const [indexError, setIndexError] = useState<string | null>(null);
  /** 全文検索パネルの開閉（Cmd+K / Ctrl+K と検索ボタンから操作する） */
  const [searchOpen, setSearchOpen] = useState(false);
  /** クイックスイッチャーの開閉（Cmd+O / Ctrl+O と移動ボタンから操作する）（M3） */
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false);
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [rightPanel, setRightPanel] = useState<'outline' | 'backlinks'>('outline');
  const [outlineContent, setOutlineContent] = useState('');

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
      // ツリー取得失敗時も検索パネル・クイックスイッチャーを「読み込み中…」のままに
      // しない（indexError を設定し、エラー表示 + 再試行導線へ切り替える）
      // （difit 指摘: ツリー取得失敗時の indexError 未設定）
      setIndexError(message);
      notify(message, { label: '再試行', onClick: () => void load() });
      return;
    }
    // ツリー取得成功後、全ノートを共有索引へ展開する。索引の失敗はツリー表示を
    // 妨げない（タグ一覧・バックリンクが非表示になるだけ）。既に展開済みの Vault は
    // レジストリが再取得せず同じ索引を返す。失敗はトーストに加えて indexError に
    // 保持し、検索パネル・クイックスイッチャーが再試行導線を表示できるようにする
    try {
      const index = await run(loadNoteIndex({ owner, name }));
      setNoteIndex(index);
      setIndexError(null);
    } catch (error) {
      const message = vaultErrorMessage(error);
      setIndexError(message);
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
  // ノート索引の更新（保存反映・再ロード）のたびに再構築される（M2）。
  // 検索対象は本文（フロントマテリアを除いたボディ）とする。フロントマテリアの
  // タグは tags フィールドで検索されるため、タグ語が本文に現れないノート
  // （インライン `#tagged` のないノート）でもタグ一致（kind='tag'）として分類される
  // （difit 指摘: タグ一致 E2E が実質 content マッチに依存していた問題）
  const searcher = useMemo<NoteSearcher | null>(() => {
    if (noteIndex === null || notation === null) {
      return null;
    }
    const notes: SearchableNote[] = [];
    for (const note of noteIndex.notes.values()) {
      const notationNote = notation.notes.get(note.path);
      const bodyStart = notationNote?.frontmatter?.to;
      notes.push({
        path: note.path,
        content: bodyStart === undefined ? note.content : note.content.slice(bodyStart),
        tags: notationNote?.tags ?? [],
      });
    }
    return createNoteSearcher(notes);
  }, [noteIndex, notation]);

  // クイックスイッチャー: 共有索引のノートパス一覧（null は索引未ロード）（M3）。
  // 検索は本文込み、クイックスイッチャーはファイル名のみの対象差があるため、
  // パス一覧だけを渡してコンポーネント側でファジー検索する
  const notePaths = useMemo<readonly string[] | null>(
    () => (noteIndex === null ? null : [...noteIndex.notes.keys()]),
    [noteIndex],
  );

  const outline = useMemo(() => collectOutline(outlineContent), [outlineContent]);

  // Cmd+K / Ctrl+K: 全文検索パネルの開閉。Cmd+O / Ctrl+O: クイックスイッチャーの
  // 開閉（M3）。両パネルは同時に開かない（オーバーレイの重なりを避ける）。
  // Cmd+S（NotePane の保存）とはキーが異なるため衝突しない
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === 'k') {
        event.preventDefault();
        setSearchOpen((open) => !open);
        setQuickSwitchOpen(false);
      } else if ((event.metaKey || event.ctrlKey) && key === 'o') {
        event.preventDefault();
        setQuickSwitchOpen((open) => !open);
        setSearchOpen(false);
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
    setIndexError(null);
    setOutlineContent('');
    setExpandedPaths(new Set(['']));
  }, [owner, name]);

  useEffect(() => {
    setOutlineContent('');
  }, [notePath]);

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

  // ツリーが取得できている間だけ全ファイルパスを算出する（リーディング表示と
  // ファイル操作のリンク張り替え入力に使う）
  const filePaths = useMemo(
    () => (state.kind === 'ready' ? collectFilePaths(state.tree.root) : []),
    [state],
  );

  /**
   * ファイル操作（作成/リネーム/移動/削除）を一括コミットで実行する（M5）。
   * 成功時はツリーを再読込し、開いているノートが操作の影響を受けた場合は
   * 新しいパス（移動・リネーム）へ、消えた場合は Vault ルートへ遷移する。
   * 張り替えられなかった曖昧参照がある場合は件数をトーストで通知する。
   */
  const runFileOperation = useCallback(
    async (operation: FileOperation, successMessage: string): Promise<void> => {
      try {
        const result = await run(applyFileOperation({ owner, name }, operation, filePaths));
        let message = successMessage;
        if (result.issues.length > 0) {
          message += `（${result.issues.length} 件のリンクは曖昧なため張り替えませんでした）`;
        }
        notify(message);
        // ツリー + 共有索引を再読込する（索引はユースケースが更新済みのため再取得されない）
        await load();
        // 開いているノートの遷移: 作成 → 新ノートを開く / 移動・リネーム → 新パス /
        // 削除（ディレクトリ削除含む） → Vault ルート
        if (operation.kind === 'create-note') {
          navigate(noteRoutePath({ owner, name }, operation.path));
        } else if (notePath !== null) {
          const moved = result.movedPaths.find((move) => move.from === notePath);
          if (moved !== undefined) {
            navigate(noteRoutePath({ owner, name }, moved.to));
          } else if (result.removedPaths.includes(notePath)) {
            navigate(vaultRoutePath({ owner, name }));
          }
        }
      } catch (error) {
        if (isSessionExpiredError(error)) {
          notify('セッションの有効期限が切れました。ログインし直してください。');
          onSessionExpired();
          return;
        }
        notify(fileErrorMessage(error));
      }
    },
    [owner, name, filePaths, notePath, notify, onSessionExpired, load],
  );

  /** ファイル操作の成功トースト文言（操作種別ごと） */
  const fileOperationMessages: Record<FileOperation['kind'], string> = {
    'create-note': 'ノートを作成しました。',
    'create-directory': 'フォルダーを作成しました。',
    'delete-note': 'ノートを削除しました。',
    'delete-directory': 'フォルダーを削除しました。',
    'rename-note': 'リネームしました。',
    'rename-directory': 'リネームしました。',
  };

  return (
    <div
      className={`vault-screen${leftSidebarOpen ? '' : ' is-left-collapsed'}${rightSidebarOpen ? '' : ' is-right-collapsed'}`}
    >
      <nav className="workspace-rail" aria-label="ワークスペース">
        <button
          type="button"
          className={`workspace-rail-button${leftSidebarOpen ? ' is-active' : ''}`}
          aria-label="ファイル"
          aria-pressed={leftSidebarOpen}
          onClick={() => setLeftSidebarOpen((open) => !open)}
        >
          ▣
        </button>
        <button
          type="button"
          className="workspace-rail-button"
          aria-label="検索"
          onClick={() => setSearchOpen(true)}
        >
          ⌕
        </button>
        <button type="button" className="workspace-rail-button" aria-label="ブックマーク">
          ♡
        </button>
        <button type="button" className="workspace-rail-button" aria-label="グラフビュー">
          ⌘
        </button>
        <button type="button" className="workspace-rail-button" aria-label="データベース">
          ▦
        </button>
        <button type="button" className="workspace-rail-button" aria-label="カレンダー">
          ▣
        </button>
        <button type="button" className="workspace-rail-button" aria-label="コマンド">
          &gt;_
        </button>
        <span className="workspace-rail-spacer" />
        <button
          type="button"
          className={`workspace-rail-button${rightSidebarOpen ? ' is-active' : ''}`}
          aria-label="右サイドバー"
          aria-pressed={rightSidebarOpen}
          onClick={() => setRightSidebarOpen((open) => !open)}
        >
          ⚙
        </button>
      </nav>
      {leftSidebarOpen && (
        <aside className="vault-sidebar">
          <div className="vault-sidebar-header">
            <Link to="/" className="vault-back-link">
              ← Vault 一覧
            </Link>
            <h2 className="vault-title">{vaultRefFullName(vaultRef)}</h2>
            <div className="vault-header-actions">
              <button
                type="button"
                className="button-secondary search-open-button"
                onClick={() => setSearchOpen(true)}
              >
                検索 <span className="search-open-shortcut">⌘K</span>
              </button>
              <button
                type="button"
                className="button-secondary search-open-button"
                onClick={() => setQuickSwitchOpen(true)}
              >
                移動 <span className="search-open-shortcut">⌘O</span>
              </button>
            </div>
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
              {noteIndex !== null && noteIndex.truncated && (
                <p className="tree-truncated-notice" role="status">
                  リポジトリが大きいため、一部のノートのみ索引化しています（検索・移動・タグ・バックリンクは不完全です）。
                </p>
              )}
              <FileTree
                root={state.tree.root}
                vaultRef={vaultRef}
                expandedPaths={expandedPaths}
                selectedPath={notePath}
                onToggleDirectory={toggleDirectory}
                onCreateNote={(noteName) =>
                  void runFileOperation(
                    { kind: 'create-note', path: noteName },
                    fileOperationMessages['create-note'],
                  )
                }
                onCreateDirectory={(directoryName) =>
                  void runFileOperation(
                    { kind: 'create-directory', path: directoryName },
                    fileOperationMessages['create-directory'],
                  )
                }
                onRename={(path, type, newName) =>
                  void runFileOperation(
                    {
                      kind: type === 'file' ? 'rename-note' : 'rename-directory',
                      from: path,
                      to: joinDirectoryPath(parentDirectoryPath(path), newName),
                    },
                    fileOperationMessages[type === 'file' ? 'rename-note' : 'rename-directory'],
                  )
                }
                onMove={(path, type, targetDirectory) =>
                  void runFileOperation(
                    {
                      kind: type === 'file' ? 'rename-note' : 'rename-directory',
                      from: path,
                      to: joinDirectoryPath(targetDirectory, pathBaseName(path)),
                    },
                    fileOperationMessages[type === 'file' ? 'rename-note' : 'rename-directory'],
                  )
                }
                onDelete={(path, type) =>
                  void runFileOperation(
                    { kind: type === 'file' ? 'delete-note' : 'delete-directory', path },
                    fileOperationMessages[type === 'file' ? 'delete-note' : 'delete-directory'],
                  )
                }
              />
            </>
          )}
        </aside>
      )}
      <section className="vault-content">
        <div className="workspace-tabs" role="tablist" aria-label="開いているノート">
          <div className="workspace-tab is-active" role="tab" aria-selected="true">
            <span>{notePath === null ? 'Vault' : pathBaseName(notePath)}</span>
            <button type="button" aria-label="タブを閉じる" disabled={notePath === null}>
              ×
            </button>
          </div>
          <button type="button" className="workspace-tab-add" aria-label="新しいタブ">
            +
          </button>
        </div>
        {notePath !== null ? (
          <NotePane
            vaultRef={vaultRef}
            notePath={notePath}
            filePaths={filePaths}
            notify={notify}
            onSessionExpired={onSessionExpired}
            onNoteSaved={handleNoteSaved}
            onNoteContentLoaded={setOutlineContent}
            onFileChanged={() => void load()}
          />
        ) : state.kind === 'ready' && state.tree.root.children.length === 0 ? (
          <EmptyVaultCta
            onCreateNote={(noteName) =>
              void runFileOperation(
                { kind: 'create-note', path: noteName },
                fileOperationMessages['create-note'],
              )
            }
          />
        ) : (
          <p className="app-placeholder">ツリーからファイルを選択してください。</p>
        )}
        <footer className="workspace-statusbar" aria-label="ステータスバー">
          <span>{state.kind === 'ready' ? state.tree.defaultBranch : 'main'}</span>
          <span>{notePath === null ? 'ノート未選択' : 'Markdown'}</span>
          <span>⌘K 検索</span>
          <span>⌘O クイックスイッチャー</span>
        </footer>
      </section>
      {rightSidebarOpen && (
        <aside className="workspace-right-sidebar" aria-label="補助ペイン">
          <div className="workspace-right-tabs" role="tablist" aria-label="補助ペイン">
            <button
              type="button"
              className={rightPanel === 'outline' ? 'is-active' : ''}
              role="tab"
              aria-selected={rightPanel === 'outline'}
              onClick={() => setRightPanel('outline')}
            >
              アウトライン
            </button>
            <button
              type="button"
              className={rightPanel === 'backlinks' ? 'is-active' : ''}
              role="tab"
              aria-selected={rightPanel === 'backlinks'}
              onClick={() => setRightPanel('backlinks')}
            >
              バックリンク
            </button>
          </div>
          {rightPanel === 'outline' && (
            <nav className="workspace-outline" aria-label="アウトライン">
              {outline.length === 0 ? (
                <p className="app-placeholder">見出しがありません。</p>
              ) : (
                outline.map((heading) => (
                  <Link
                    key={`${heading.slug}-${heading.level}`}
                    to={`${noteRoutePath(vaultRef, notePath ?? '')}#${heading.slug}`}
                    className="workspace-outline-link"
                    style={{ '--outline-level': heading.level } as CSSProperties}
                  >
                    {heading.text}
                  </Link>
                ))
              )}
            </nav>
          )}
          {rightPanel === 'backlinks' && notation !== null && (
            <>
              {notePath !== null && (
                <section className="vault-sidebar-section" aria-label="バックリンク">
                  <h3 className="vault-sidebar-section-title">バックリンク</h3>
                  <BacklinkPanel
                    vaultRef={vaultRef}
                    links={notation.backlinks.get(notePath) ?? []}
                  />
                </section>
              )}
            </>
          )}
          {rightPanel === 'backlinks' && notation !== null && (
            <section className="vault-sidebar-section" aria-label="タグ一覧">
              <h3 className="vault-sidebar-section-title">タグ</h3>
              <TagPanel vaultRef={vaultRef} tagIndex={notation.tagIndex} notes={notation.notes} />
            </section>
          )}
        </aside>
      )}
      {searchOpen && (
        <SearchPanel
          vaultRef={vaultRef}
          searcher={searcher}
          indexFailed={indexError !== null}
          onRetry={() => void load()}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {quickSwitchOpen && (
        <QuickSwitcher
          vaultRef={vaultRef}
          notePaths={notePaths}
          indexFailed={indexError !== null}
          onRetry={() => void load()}
          onClose={() => setQuickSwitchOpen(false)}
        />
      )}
    </div>
  );
}
