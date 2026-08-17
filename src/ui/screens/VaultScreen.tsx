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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { applyFileOperation } from '@/application/file';
import type { FileOperation } from '@/application/file';
import { applySavedNote, loadNoteIndex } from '@/application/note-index';
import type { NoteIndex } from '@/application/note-index';
import { createNoteSearcher } from '@/application/search';
import type { NoteSearcher, SearchableNote } from '@/application/search';
import { initializeVault, openVault, fetchVaultSyncStatus, syncVault } from '@/application/vault';
import type { SyncProgress, VaultSyncConflict, VaultSyncStatus } from '@/application/vault';
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

function collectDirectoryPaths(root: TreeDirectory): string[] {
  const paths: string[] = [''];
  const walk = (directory: TreeDirectory): void => {
    for (const child of directory.children) {
      if (child.type === 'directory') {
        paths.push(child.path);
        walk(child);
      }
    }
  };
  walk(root);
  return paths;
}

const SIDEBAR_WIDTH_KEY = 'tektite.sidebar.width';
const DEFAULT_SIDEBAR_WIDTH = 200;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 420;

/** ファイル操作の成功トースト文言（操作種別ごと。モジュール定数） */
const FILE_OPERATION_MESSAGES: Record<FileOperation['kind'], string> = {
  'create-note': 'ノートを作成しました。',
  'create-directory': 'フォルダーを作成しました。',
  'delete-note': 'ノートを削除しました。',
  'delete-directory': 'フォルダーを削除しました。',
  'rename-note': 'リネームしました。',
  'rename-directory': 'リネームしました。',
  'duplicate-note': 'ノートを複製しました。',
  'duplicate-directory': 'フォルダーを複製しました。',
};

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

/** 同期時刻の表示（ローカル時刻の時:分。パース不能な場合はそのまま返す） */
function formatSyncTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function readSidebarWidth(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(stored) ? clampSidebarWidth(stored) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
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

type WorkspaceIconName =
  | 'files'
  | 'search'
  | 'bookmark'
  | 'database'
  | 'calendar'
  | 'command'
  | 'sidebar';

function WorkspaceIcon({ name }: { name: WorkspaceIconName }) {
  const paths: Record<WorkspaceIconName, string> = {
    files: 'M3 4.5h14v11H3z M6 2.5h8v2H6z M6 8h8 M6 11h5',
    search: 'm14 14 3.5 3.5 M15 9.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z',
    bookmark: 'M5 3.5h10v13l-5-3-5 3z',
    database:
      'M4 5c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2Z M4 5v5c0 1.1 2.2 2 5 2s5-.9 5-2V5 M4 10v5c0 1.1 2.2 2 5 2s5-.9 5-2v-5',
    calendar: 'M4 4h12v12H4z M7 2.5v3 M13 2.5v3 M4 8h12',
    command: 'M5 5l5 5-5 5 M11 15h4',
    sidebar: 'M3 3.5h14v13H3z M12 3.5v13',
  };
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d={paths[name]} />
    </svg>
  );
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
  /**
   * 初期同期の実行中フラグ（M3）。Vault を開くたびに初期同期 API を呼び、
   * R2 に同期済みメタがある場合はサーバーが即座に完了を返す（初回のみ
   * GitHub API を消費）。同期中はツリーの代わりに進捗メッセージを表示し、
   * 完了後に Vault を開く（完了条件 2 の進捗画面）。
   */
  const [initializing, setInitializing] = useState(false);
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
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  /**
   * 未確定（未コミット）の新規ノートパス（Obsidian 式の新規作成）。
   * ツールバーやコンテキストメニューの「新規ノート」でデフォルト名
   * （Untitled.md など）を決めてエディタを開き、タイトル確定（Enter / blur）
   * か自動保存（blur）で最終名のコミットが 1 回だけ行われる（Q15:2）。
   * Escape で破棄（Q19）。null は未確定ノートなし。
   */
  const [pendingNotePath, setPendingNotePath] = useState<string | null>(null);
  /**
   * 明示同期の実行中フラグ（M5）。ヘッダーの同期ボタンから実行する。
   */
  const [syncing, setSyncing] = useState(false);
  /**
   * 同期の進捗（オーバーレイ表示用）。初期同期・明示同期の実行中に
   * application 層から通知される。null は進捗不明（開始直後）か同期中でない。
   */
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  /** 同期オーバーレイのルート要素（表示中にフォーカスを移して編集をブロックする） */
  const syncOverlayRef = useRef<HTMLDivElement>(null);

  // 同期中はオーバーレイへフォーカスを移してキー入力を追い出し、背後にある
  // ノートエディタが意図せず編集されるのを防ぐ
  useEffect(() => {
    if (initializing || syncing) {
      syncOverlayRef.current?.focus();
    }
  }, [initializing, syncing]);
  /**
   * 同期状態（最終同期時刻・失敗マーク。完了条件 10）。
   * Vault オープン時に GET /sync で取得し、定時同期の失敗（lastSyncError）を
   * 表示する。明示同期の成功後は取得し直して最新化する。
   */
  const [syncStatus, setSyncStatus] = useState<VaultSyncStatus | null>(null);
  /**
   * 明示同期で検出された未解決の同期衝突（M5。完了条件 6）。
   * 開いているノートが衝突パスに含まれる場合、NotePane に渡して
   * 差分表示 + 上書き/取り込みで解決する。
   */
  const [syncConflicts, setSyncConflicts] = useState<readonly VaultSyncConflict[]>([]);
  /**
   * 同期完了ごとに増えるバージョン（NotePane への最新化通知。完了条件 9）。
   * 未編集で開いているノートは同期後に再読み込みされ、編集中のノートは
   * エディタの内容が保持される。
   */
  const [syncVersion, setSyncVersion] = useState(0);

  // オブジェクトの同一性ではなく値（owner / name）で依存を比較する
  // （ツリー ↔ ノートのルーティング往来で再取得しないため）
  const { owner, name } = vaultRef;

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    // 初期同期: 初回のみ GitHub から R2 へ全量を取り込み、以降は R2 読み取りに
    // なる（サーバーは同期済みなら GitHub を消費せず即完了を返す）。失敗しても
    // ツリー取得へ進む（R2 未設定環境のフォールバック。実エラーはトースト通知）
    setInitializing(true);
    setSyncProgress(null);
    try {
      await run(initializeVault({ owner, name }, setSyncProgress));
    } catch (error) {
      if (isSessionExpiredError(error)) {
        setInitializing(false);
        setSyncProgress(null);
        notify('セッションの有効期限が切れました。ログインし直してください。');
        onSessionExpired();
        return;
      }
      notify(vaultErrorMessage(error));
    }
    setInitializing(false);
    setSyncProgress(null);
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

  // Vault オープン時に同期状態（最終同期時刻・失敗マーク）を取得する。
  // 定時同期の失敗が meta に記録されているため、次回オープン時に表示される
  // （完了条件 10）。取得失敗は表示を諦めるだけ（同期ボタン自体は使える）
  useEffect(() => {
    let cancelled = false;
    void run(fetchVaultSyncStatus({ owner, name }))
      .then((status) => {
        if (!cancelled) {
          setSyncStatus(status);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner, name]);

  /**
   * 明示同期（M5。完了条件 5 / 6 / 9）。
   * ヘッダーの同期ボタンから即時同期を実行し、結果（プル/プッシュ件数・
   * 同期衝突）をトーストと状態表示へ反映する。完了後はツリーと索引を再読込し、
   * 開いているノートへ syncVersion で最新化を通知する。
   */
  const runSync = useCallback(async (): Promise<void> => {
    if (syncing) {
      return;
    }
    setSyncing(true);
    setSyncProgress(null);
    try {
      const result = await run(syncVault({ owner, name }, setSyncProgress));
      const newConflicts = result.conflicts ?? [];
      setSyncConflicts(newConflicts);
      setSyncVersion((version) => version + 1);
      if (newConflicts.length > 0) {
        const openConflict = notePath !== null && newConflicts.some((c) => c.path === notePath);
        notify(
          openConflict
            ? '同期中に編集内容と GitHub の内容が衝突しました。差分を確認して解決してください。'
            : `${newConflicts.length} 件の同期衝突があります。該当ノートを開いて解決してください。`,
        );
      } else {
        const pushed = result.pushed ?? 0;
        const pulled = result.pulled ?? 0;
        notify(
          pushed > 0 || pulled > 0
            ? `同期しました（プル ${pulled} 件 / プッシュ ${pushed} 件）。`
            : '同期しました（変更はありませんでした）。',
        );
      }
      // ツリー・索引・同期状態を最新化する（ツリーは R2 から読み直すため GitHub は消費しない）
      await load();
      const status = await run(fetchVaultSyncStatus({ owner, name })).catch(() => null);
      if (status !== null) {
        setSyncStatus(status);
      }
    } catch (error) {
      if (isSessionExpiredError(error)) {
        notify('セッションの有効期限が切れました。ログインし直してください。');
        onSessionExpired();
        return;
      }
      notify(vaultErrorMessage(error));
    } finally {
      setSyncing(false);
      setSyncProgress(null);
    }
  }, [syncing, owner, name, notePath, notify, onSessionExpired, load]);

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
    setPendingNotePath(null);
  }, [owner, name]);

  useEffect(() => {
    setOutlineContent('');
  }, [notePath]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      // localStorage may be unavailable in private browsing or restricted frames.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    if (!resizingSidebar) {
      return;
    }
    const handlePointerMove = (event: PointerEvent): void => {
      setSidebarWidth(clampSidebarWidth(event.clientX - 44));
    };
    const stopResizing = (): void => setResizingSidebar(false);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResizing, { once: true });
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResizing);
    };
  }, [resizingSidebar]);

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

  const revealCurrentNote = useCallback((): void => {
    if (notePath === null) {
      return;
    }
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      for (const ancestor of ancestorDirectoryPaths(notePath)) {
        next.add(ancestor);
      }
      return next;
    });
  }, [notePath]);

  const allDirectoryPaths = useMemo(
    () => (state.kind === 'ready' ? collectDirectoryPaths(state.tree.root) : []),
    [state],
  );
  const allExpanded =
    allDirectoryPaths.length > 0 && allDirectoryPaths.every((path) => expandedPaths.has(path));
  const toggleAllDirectories = useCallback((): void => {
    setExpandedPaths(allExpanded ? new Set(['']) : new Set(allDirectoryPaths));
  }, [allDirectoryPaths, allExpanded]);

  // ツリーが取得できている間だけ全ファイルパスを算出する（リーディング表示と
  // ファイル操作のリンク張り替え入力に使う）
  const filePaths = useMemo(
    () => (state.kind === 'ready' ? collectFilePaths(state.tree.root) : []),
    [state],
  );

  /**
   * ファイル操作（作成/リネーム/移動/削除/複製）を一括コミットで実行する（M5）。
   * 成功時はツリーを再読込し、開いているノートが操作の影響を受けた場合は
   * 新しいパス（移動・リネーム）へ、消えた場合は Vault ルートへ遷移する。
   * 張り替えられなかった曖昧参照がある場合は件数をトーストで通知する。
   * 戻り値は成功したかどうか（コミットと検証をまとめて 1 回の成否判定にする）。
   */
  const runFileOperation = useCallback(
    async (operation: FileOperation, successMessage: string): Promise<boolean> => {
      try {
        const result = await run(applyFileOperation({ owner, name }, operation, filePaths));
        let message = successMessage;
        if (result.issues.length > 0) {
          message += `（${result.issues.length} 件のリンクは曖昧なため張り替えませんでした）`;
        }
        notify(message);
        // ツリー + 共有索引を再読込する（索引はユースケースが更新済みのため再取得されない）
        await load();
        // 開いているノートの遷移: 移動・リネーム → 新パス /
        // 削除（ディレクトリ削除含む） → Vault ルート。
        // 新規作成（create-note）の遷移は commitPendingNote が担う
        if (notePath !== null) {
          const moved = result.movedPaths.find((move) => move.from === notePath);
          if (moved !== undefined) {
            navigate(noteRoutePath({ owner, name }, moved.to));
          } else if (result.removedPaths.includes(notePath)) {
            navigate(vaultRoutePath({ owner, name }));
          }
        }
        return true;
      } catch (error) {
        if (isSessionExpiredError(error)) {
          notify('セッションの有効期限が切れました。ログインし直してください。');
          onSessionExpired();
          return false;
        }
        notify(fileErrorMessage(error));
        return false;
      }
    },
    [owner, name, filePaths, notePath, notify, onSessionExpired, load],
  );

  /**
   * Obsidian 式の複製名（`a copy.md` → `a copy 1.md` → …）を既存ファイルと
   * 衝突しない形で計算する（ディレクトリは拡張子なし: `daily copy` → …）。
   */
  const nextDuplicatePath = useCallback(
    (path: string, type: 'file' | 'directory'): string => {
      const directory = parentDirectoryPath(path);
      const base = pathBaseName(path);
      const dot = base.lastIndexOf('.');
      const stem = type === 'file' && dot > 0 ? base.slice(0, dot) : base;
      const ext = type === 'file' && dot > 0 ? base.slice(dot) : '';
      const existing = new Set(filePaths.map((p) => p.toLowerCase()));
      let candidate = `${stem} copy${ext}`;
      let index = 1;
      while (existing.has(joinDirectoryPath(directory, candidate).toLowerCase())) {
        candidate = `${stem} copy ${index}${ext}`;
        index += 1;
      }
      return joinDirectoryPath(directory, candidate);
    },
    [filePaths],
  );

  /** 複製を作成し、複製先を選択状態にする（ノートは開く / フォルダは展開） */
  const handleDuplicate = useCallback(
    async (path: string, type: 'file' | 'directory'): Promise<void> => {
      const to = nextDuplicatePath(path, type);
      const kind = type === 'file' ? 'duplicate-note' : 'duplicate-directory';
      const ok = await runFileOperation({ kind, from: path, to }, FILE_OPERATION_MESSAGES[kind]);
      if (!ok) {
        return;
      }
      if (type === 'file') {
        navigate(noteRoutePath({ owner, name }, to));
      } else {
        setExpandedPaths((previous) => new Set(previous).add(to));
      }
    },
    [nextDuplicatePath, runFileOperation, owner, name],
  );

  /** 未確定ノートのデフォルト名（Untitled.md / Untitled 1.md …）を決める */
  const nextUntitledPath = useCallback(
    (directory: string): string => {
      const existing = new Set(filePaths.map((p) => p.toLowerCase()));
      let candidate = 'Untitled.md';
      let index = 1;
      while (existing.has(joinDirectoryPath(directory, candidate).toLowerCase())) {
        candidate = `Untitled ${index}.md`;
        index += 1;
      }
      return joinDirectoryPath(directory, candidate);
    },
    [filePaths],
  );

  /** 新規ノートを開始する（Obsidian 式: デフォルト名でエディタを開き、コミットは保留） */
  const startNewNote = useCallback(
    (directory: string): void => {
      const path = nextUntitledPath(directory);
      setPendingNotePath(path);
      navigate(noteRoutePath({ owner, name }, path));
    },
    [nextUntitledPath, owner, name],
  );

  /** 未確定ノートを最終名 + 本文で 1 コミットで作成する（成功で true） */
  const commitPendingNote = useCallback(
    async (finalName: string, content: string): Promise<boolean> => {
      if (pendingNotePath === null) {
        return false;
      }
      const finalPath = joinDirectoryPath(parentDirectoryPath(pendingNotePath), finalName);
      const ok = await runFileOperation(
        { kind: 'create-note', path: finalPath, content },
        FILE_OPERATION_MESSAGES['create-note'],
      );
      if (ok) {
        setPendingNotePath(null);
        // リネームされた場合のみ最終パスへ遷移する（ユーザーが既に別ノートへ
        // 移動していた場合は、その移動を上書きしない）
        if (finalPath !== pendingNotePath && notePath === pendingNotePath) {
          navigate(noteRoutePath({ owner, name }, finalPath));
        }
      }
      return ok;
    },
    [pendingNotePath, runFileOperation, owner, name, notePath],
  );

  /** 未確定ノートを破棄する（Escape。何もコミットしない） */
  const discardPendingNote = useCallback((): void => {
    setPendingNotePath(null);
    navigate(vaultRoutePath({ owner, name }));
  }, [owner, name]);

  /** 同期衝突の解決完了時に一覧から除去する（NotePane からの通知） */
  const handleSyncConflictResolved = useCallback((path: string): void => {
    setSyncConflicts((previous) => previous.filter((conflict) => conflict.path !== path));
  }, []);

  /** 同期状態の表示ラベル（最終同期時刻・失敗マーク。完了条件 10） */
  const syncStatusLabel = syncing
    ? '同期中…'
    : syncStatus !== null && syncStatus.lastSyncError !== null
      ? `同期失敗（${syncStatus.lastSyncError}）`
      : syncStatus !== null && syncStatus.syncedAt !== null
        ? `最終同期 ${formatSyncTime(syncStatus.syncedAt)}`
        : '未同期';

  /** 開いているノートに対応する同期衝突（無ければ null） */
  const currentSyncConflict =
    notePath === null
      ? null
      : (syncConflicts.find((conflict) => conflict.path === notePath) ?? null);

  return (
    <div
      className={`vault-screen${leftSidebarOpen ? '' : ' is-left-collapsed'}${rightSidebarOpen ? '' : ' is-right-collapsed'}${resizingSidebar ? ' is-resizing' : ''}`}
      style={{ '--vault-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <nav className="workspace-rail" aria-label="ワークスペース">
        <button
          type="button"
          className={`workspace-rail-button${leftSidebarOpen ? ' is-active' : ''}`}
          aria-label="ファイル"
          aria-pressed={leftSidebarOpen}
          onClick={() => setLeftSidebarOpen((open) => !open)}
        >
          <WorkspaceIcon name="files" />
        </button>
        <button
          type="button"
          className="workspace-rail-button"
          aria-label="検索"
          onClick={() => setSearchOpen(true)}
        >
          <WorkspaceIcon name="search" />
        </button>
        <button type="button" className="workspace-rail-button" aria-label="ブックマーク">
          <WorkspaceIcon name="bookmark" />
        </button>
        <button type="button" className="workspace-rail-button" aria-label="データベース">
          <WorkspaceIcon name="database" />
        </button>
        <button type="button" className="workspace-rail-button" aria-label="カレンダー">
          <WorkspaceIcon name="calendar" />
        </button>
        <button type="button" className="workspace-rail-button" aria-label="コマンド">
          <WorkspaceIcon name="command" />
        </button>
        <span className="workspace-rail-spacer" />
        <button
          type="button"
          className={`workspace-rail-button${rightSidebarOpen ? ' is-active' : ''}`}
          aria-label="右サイドバー"
          aria-pressed={rightSidebarOpen}
          onClick={() => setRightSidebarOpen((open) => !open)}
        >
          <WorkspaceIcon name="sidebar" />
        </button>
      </nav>
      {leftSidebarOpen && (
        <aside className="vault-sidebar">
          <div className="sidebar-workspace-tab" aria-label="ファイルエクスプローラ">
            <button type="button" aria-label="ファイル" aria-pressed="true">
              <WorkspaceIcon name="files" />
            </button>
            <button type="button" aria-label="検索" onClick={() => setSearchOpen(true)}>
              <WorkspaceIcon name="search" />
            </button>
            <button type="button" aria-label="ブックマーク">
              <WorkspaceIcon name="bookmark" />
            </button>
          </div>
          <div className="vault-sidebar-header">
            <Link to="/" className="vault-back-link">
              ← Vault 一覧
            </Link>
            <h2 className="vault-title">{vaultRefFullName(vaultRef)}</h2>
          </div>
          {initializing && (
            <p className="app-placeholder" role="status">
              Vault を初期同期しています…
            </p>
          )}
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
                onOpenSearch={() => setSearchOpen(true)}
                onOpenQuickSwitcher={() => setQuickSwitchOpen(true)}
                onRevealCurrent={revealCurrentNote}
                onToggleAll={toggleAllDirectories}
                allExpanded={allExpanded}
                onCreateNote={(directory) => startNewNote(directory)}
                onCreateDirectory={(directory, directoryName) =>
                  void runFileOperation(
                    { kind: 'create-directory', path: joinDirectoryPath(directory, directoryName) },
                    FILE_OPERATION_MESSAGES['create-directory'],
                  )
                }
                onDuplicate={(path, type) => void handleDuplicate(path, type)}
                onRename={(path, type, newName) =>
                  void runFileOperation(
                    {
                      kind: type === 'file' ? 'rename-note' : 'rename-directory',
                      from: path,
                      to: joinDirectoryPath(parentDirectoryPath(path), newName),
                    },
                    FILE_OPERATION_MESSAGES[type === 'file' ? 'rename-note' : 'rename-directory'],
                  )
                }
                onMove={(path, type, targetDirectory) =>
                  void runFileOperation(
                    {
                      kind: type === 'file' ? 'rename-note' : 'rename-directory',
                      from: path,
                      to: joinDirectoryPath(targetDirectory, pathBaseName(path)),
                    },
                    FILE_OPERATION_MESSAGES[type === 'file' ? 'rename-note' : 'rename-directory'],
                  )
                }
                onDelete={(path, type) =>
                  void runFileOperation(
                    { kind: type === 'file' ? 'delete-note' : 'delete-directory', path },
                    FILE_OPERATION_MESSAGES[type === 'file' ? 'delete-note' : 'delete-directory'],
                  )
                }
              />
            </>
          )}
          <div
            className="vault-sidebar-resizer"
            role="separator"
            aria-label="サイドバー幅を変更"
            aria-orientation="vertical"
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            aria-valuenow={sidebarWidth}
            onPointerDown={(event) => {
              event.preventDefault();
              setResizingSidebar(true);
            }}
          />
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
        <div className="workspace-navigation" aria-label="ノートナビゲーション">
          <button type="button" aria-label="戻る" onClick={() => window.history.back()}>
            ‹
          </button>
          <button type="button" aria-label="進む" onClick={() => window.history.forward()}>
            ›
          </button>
          <span />
          <button type="button" aria-label="ノートを開く">
            ◫
          </button>
          <button type="button" aria-label="その他の操作">
            …
          </button>
          <span className="workspace-navigation-spacer" />
          <span
            className={`sync-status${syncStatus !== null && syncStatus.lastSyncError !== null ? ' has-error' : ''}`}
            data-testid="sync-status"
            title={
              syncStatus !== null && syncStatus.lastSyncError !== null
                ? `定時同期が失敗しました（${syncStatus.lastSyncError}）。次回同期で自動リトライされます。`
                : 'Vault と GitHub の最終同期時刻'
            }
          >
            {syncStatusLabel}
          </span>
          <button
            type="button"
            className="button-secondary sync-button"
            data-testid="sync-button"
            onClick={() => void runSync()}
            disabled={syncing || initializing || state.kind === 'loading'}
          >
            {syncing ? '同期中…' : '同期'}
          </button>
        </div>
        {notePath !== null ? (
          <NotePane
            vaultRef={vaultRef}
            notePath={notePath}
            filePaths={filePaths}
            pendingPath={pendingNotePath}
            notify={notify}
            onSessionExpired={onSessionExpired}
            onNoteSaved={handleNoteSaved}
            onNoteContentLoaded={setOutlineContent}
            onFileChanged={() => void load()}
            onPendingCommit={commitPendingNote}
            onPendingDiscard={discardPendingNote}
            onRenameNote={(path, newName) =>
              runFileOperation(
                {
                  kind: 'rename-note',
                  from: path,
                  to: joinDirectoryPath(parentDirectoryPath(path), newName),
                },
                FILE_OPERATION_MESSAGES['rename-note'],
              )
            }
            syncVersion={syncVersion}
            syncConflict={currentSyncConflict}
            onSyncConflictResolved={handleSyncConflictResolved}
          />
        ) : state.kind === 'ready' && state.tree.root.children.length === 0 ? (
          <EmptyVaultCta onCreateNote={() => startNewNote('')} />
        ) : (
          <p className="app-placeholder">
            {initializing
              ? 'Vault を初期同期しています…'
              : 'ツリーからファイルを選択してください。'}
          </p>
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
      {(initializing || syncing) && (
        <div
          ref={syncOverlayRef}
          className="sync-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="同期中"
          aria-busy="true"
          tabIndex={-1}
          data-testid="sync-overlay"
        >
          <div className="sync-overlay-panel">
            <div className="sync-spinner" aria-hidden="true" />
            <p className="sync-overlay-title">
              {initializing ? 'Vault を初期同期しています…' : 'Vault を同期しています…'}
            </p>
            {syncProgress !== null && (
              <p className="sync-overlay-progress" data-testid="sync-progress">
                {Math.round(syncProgress.fraction * 100)}%
                {syncProgress.remaining > 0 ? `（残り約 ${syncProgress.remaining} 件）` : ''}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
