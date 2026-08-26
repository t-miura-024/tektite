/**
 * NotePane の状態・ref・依存値を一元管理するコアフック。
 * 読み込み / 保存 / タイトル編集 / 同期衝突解決の各フィーチャーフックが
 * 共有する。状態の実体はここにのみある。
 */

import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

import type { Draft } from '@/application/draft';
import type { NoteContent } from '@/application/note';
import type { VaultSyncConflict } from '@/application/vault';
import type { EditorHandle } from '@/composition';
import type { VaultRef } from '@/domain/vault';
import type { ToastAction } from '@/ui/toast';

export type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; note: NoteContent }
  | { kind: 'error'; message: string };

/** ペインの表示モード（Obsidian のパネル設定に倣いノート切替をまたいで保持する） */
export type PaneMode = 'edit' | 'read';

/** 保存状態（表示用。conflict は別状態として持つ） */
export type SaveStatus = 'clean' | 'dirty' | 'saving';

/** 競合状態（エディタはアンマウントされ、パネルで解決する） */
export type ConflictState = {
  /** 保存に失敗した編集中の内容（スナップショット） */
  local: string;
  /** 競合検出後に再取得したリモートの内容 */
  remote: NoteContent;
};

export type NotePaneProps = {
  vaultRef: VaultRef;
  /** 表示・編集対象のノートパス（Vault ルートからの / 区切り） */
  notePath: string;
  /** Vault 内の全ファイルパス（リーディング表示の WikiLink / Embed 解決用） */
  filePaths: readonly string[];
  /**
   * 未確定（未コミット）の新規ノートパス。notePath と一致したら Obsidian 式の
   * 新規ノートとして扱う（fetch せず空のエディタを開く）。null は通常のノート。
   */
  pendingPath?: string | null;
  notify: (message: string, action?: ToastAction) => void;
  onSessionExpired: () => void;
  /** 保存成功時に呼ばれる（パス + 保存後の本文）。索引キャッシュ更新用 */
  onNoteSaved?: (path: string, content: string) => void;
  /** ノート本文を補助ペインのアウトラインへ渡す */
  onNoteContentLoaded?: (content: string) => void;
  /** 画像アップロード成功時に呼ばれる。ツリー再読込の依頼に使う */
  onFileChanged?: () => void;
  /** 未確定ノートを最終名 + 本文で 1 コミットで作成する（成功で true） */
  onPendingCommit?: (finalName: string, content: string) => Promise<boolean>;
  /** 未確定ノートを破棄する（Escape。何もコミットしない） */
  onPendingDiscard?: () => void;
  /** インラインタイトル編集からのリネーム（成功で true） */
  onRenameNote?: (path: string, newName: string) => Promise<boolean>;
  /** 同期完了ごとに増えるバージョン（M5）。未保存でなければ再読み込みする */
  syncVersion?: number;
  /** 明示同期で検出された同期衝突（M5）。差分表示 + 上書き/取り込みで解決する */
  syncConflict?: VaultSyncConflict | null;
  /** 同期衝突の解決が完了したときに呼ばれる（VaultScreen が一覧から除去する） */
  onSyncConflictResolved?: (path: string) => void;
};

/** dirty フラグと保存状態表示を同時に動かすヘルパの型 */
export type SetDirty = (dirty: boolean) => void;

/** useNotePaneCore の戻り値（各フィーチャーフックへ渡す状態・ref・依存の束） */
export type NotePaneCore = {
  props: NotePaneProps;
  vaultRef: VaultRef;
  owner: string;
  name: string;
  notePath: string;
  isPending: boolean;
  syncVersion: number;
  syncConflict: VaultSyncConflict | null;
  loadState: LoadState;
  setLoadState: Dispatch<SetStateAction<LoadState>>;
  saveStatus: SaveStatus;
  setSaveStatus: Dispatch<SetStateAction<SaveStatus>>;
  conflict: ConflictState | null;
  setConflict: Dispatch<SetStateAction<ConflictState | null>>;
  draftNotice: Draft | null;
  setDraftNotice: Dispatch<SetStateAction<Draft | null>>;
  editorContent: string;
  setEditorContent: Dispatch<SetStateAction<string>>;
  titleName: string;
  setTitleName: Dispatch<SetStateAction<string>>;
  titleEditing: boolean;
  setTitleEditing: Dispatch<SetStateAction<boolean>>;
  titleDraft: string;
  setTitleDraft: Dispatch<SetStateAction<string>>;
  titleError: string | null;
  setTitleError: Dispatch<SetStateAction<string | null>>;
  handleRef: MutableRefObject<EditorHandle | null>;
  shaRef: MutableRefObject<string | null>;
  contentRef: MutableRefObject<string>;
  dirtyRef: MutableRefObject<boolean>;
  savingRef: MutableRefObject<boolean>;
  conflictRef: MutableRefObject<boolean>;
  readyRef: MutableRefObject<boolean>;
  programmaticRef: MutableRefObject<boolean>;
  generationRef: MutableRefObject<number>;
  titleEditingRef: MutableRefObject<boolean>;
  suppressBlurRef: MutableRefObject<boolean>;
  titleNameRef: MutableRefObject<string>;
  setDirty: SetDirty;
  notify: (message: string, action?: ToastAction) => void;
  onSessionExpired: () => void;
  onNoteContentLoaded?: ((content: string) => void) | undefined;
};

export function useNotePaneCore(props: NotePaneProps): NotePaneCore {
  const { vaultRef, notePath, pendingPath = null, syncVersion = 0, syncConflict = null } = props;
  // isPending: URL パスと pending パスが一致している間だけ true（未確定の新規ノート）
  const { owner, name } = vaultRef;
  const isPending = notePath === pendingPath;

  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('clean');
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [draftNotice, setDraftNotice] = useState<Draft | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [titleName, setTitleName] = useState('');
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);

  // イベントコールバックから最新値を読むための ref（レンダーを跨いで安定させる）
  const handleRef = useRef<EditorHandle | null>(null);
  const shaRef = useRef<string | null>(null);
  const contentRef = useRef('');
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const conflictRef = useRef(false);
  const readyRef = useRef(false);
  // setContent（プログラム的置換）中の onChange を無視するフラグ / load ごとの世代
  const programmaticRef = useRef(false);
  const generationRef = useRef(0);
  const titleEditingRef = useRef(false);
  const suppressBlurRef = useRef(false);
  const titleNameRef = useRef('');

  const setDirty = useCallback((dirty: boolean): void => {
    dirtyRef.current = dirty;
    setSaveStatus(dirty ? 'dirty' : 'clean');
  }, []);
  return {
    props,
    vaultRef,
    owner,
    name,
    notePath,
    isPending,
    syncVersion,
    syncConflict,
    loadState,
    setLoadState,
    saveStatus,
    setSaveStatus,
    conflict,
    setConflict,
    draftNotice,
    setDraftNotice,
    editorContent,
    setEditorContent,
    titleName,
    setTitleName,
    titleEditing,
    setTitleEditing,
    titleDraft,
    setTitleDraft,
    titleError,
    setTitleError,
    handleRef,
    shaRef,
    contentRef,
    dirtyRef,
    savingRef,
    conflictRef,
    readyRef,
    programmaticRef,
    generationRef,
    titleEditingRef,
    suppressBlurRef,
    titleNameRef,
    setDirty,
    notify: props.notify,
    onSessionExpired: props.onSessionExpired,
    onNoteContentLoaded: props.onNoteContentLoaded,
  };
}
