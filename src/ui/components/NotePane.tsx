/**
 * ノートペイン（Vault 内画面のメインペイン。選択中ノートの表示と編集）。
 *
 * M1/M2 のノート読み込み・CM6 エディタ表示に加え、M3 の保存パイプラインを担う:
 *
 * - 明示保存: 保存ボタン + Cmd+S / Ctrl+S（saveNoteContent ユースケース）
 * - 保存状態表示: 未保存 / 保存中… / 保存済み / 競合
 * - 自動保存: エディタからのフォーカス喪失すべて（ノート切替・ツリー操作・
 *   ウィンドウ blur を問わない単一ルール）。未保存の変更がある場合のみコミットする
 * - 競合（Conflict）: NoteSaveError kind: conflict で Conflict 状態へ遷移し、
 *   「差分表示 + 上書き（最新 sha で再コミット）/ 取り込み（リモートを再取得して
 *   破棄）」の 2 択で解決する（自動マージなし）
 * - Draft: 本文が変わるたびに localStorage（DraftStore）へ退避し、ノートを開いた
 *   時に Draft があれば「未保存の変更が復元されました」と通知して復元/破棄を
 *   選ばせる。保存成功時は Draft を削除する
 *
 * エラー UX 基本方針: トースト表示 + リトライ（コンテンツ側にもリトライ導線）。
 * ユースケースの実行は組成ルート（src/composition）の run() 経由で行う。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { clearDraft, loadDraft, saveDraft } from '@/application/draft';
import type { Draft } from '@/application/draft';
import { uploadImage, validateEntryName } from '@/application/file';
import { NoteSaveError, openNote, saveNoteContent } from '@/application/note';
import type { NoteContent } from '@/application/note';
import { resolveVaultSyncConflict } from '@/application/vault';
import type { VaultSyncConflict } from '@/application/vault';
import { run } from '@/composition';
import type { EditorHandle } from '@/composition';
import { slugify } from '@/composition';
import type { VaultRef } from '@/domain/vault';
import { pathBaseName } from '@/domain/tree';

import { ConflictPanel } from '@/ui/components/ConflictPanel';
import { NoteEditor } from '@/ui/components/NoteEditor';
import { ReadingView } from '@/ui/components/ReadingView';
import { fileToBase64, imageFileName } from '@/ui/image-upload';
import { fileErrorMessage, noteErrorMessage, noteSaveErrorMessage } from '@/ui/note-error';
import { navigate, noteRoutePath, NAVIGATE_EVENT_NAME, vaultRoutePath } from '@/ui/router';
import type { ToastAction } from '@/ui/toast';
import { isSessionExpiredError } from '@/ui/vault-error';

export interface NotePaneProps {
  vaultRef: VaultRef;
  /** 表示・編集対象のノートパス（Vault ルートからの / 区切り） */
  notePath: string;
  /** Vault 内の全ファイルパス（リーディング表示の WikiLink / Embed 解決用） */
  filePaths: readonly string[];
  /**
   * 未確定（未コミット）の新規ノートパス。notePath と一致したら Obsidian 式の
   * 新規ノートとして扱う（fetch せず空のエディタを開き、タイトル編集と
   * 自動保存が最終名での作成コミットになる）。null は通常のノート。
   */
  pendingPath?: string | null;
  notify: (message: string, action?: ToastAction) => void;
  onSessionExpired: () => void;
  /**
   * 保存成功時に呼ばれる（パス + 保存後の本文）。
   * VaultScreen が記法索引のキャッシュを更新するために使う（再取得なし）。
   */
  onNoteSaved?: (path: string, content: string) => void;
  /** ノート本文を補助ペインのアウトラインへ渡す。 */
  onNoteContentLoaded?: (content: string) => void;
  /**
   * 画像アップロード成功時に呼ばれる。VaultScreen がツリーを再読込して
   * 新しい添付ファイルをツリー・Embed 解決へ反映するために使う。
   */
  onFileChanged?: () => void;
  /** 未確定ノートを最終名 + 本文で 1 コミットで作成する（成功で true） */
  onPendingCommit?: (finalName: string, content: string) => Promise<boolean>;
  /** 未確定ノートを破棄する（Escape。何もコミットしない） */
  onPendingDiscard?: () => void;
  /** インラインタイトル編集からのリネーム（成功で true） */
  onRenameNote?: (path: string, newName: string) => Promise<boolean>;
  /**
   * 同期完了ごとに増えるバージョン（M5）。変更されたとき、未保存（dirty）で
   * なければノートを再読み込みして最新化する（完了条件 9: 未編集で開いている
   * Note は同期後に最新化される。編集中の Note は上書きされない）。
   */
  syncVersion?: number;
  /**
   * 明示同期で検出された同期衝突（M5。完了条件 6）。現在のノートが衝突パスに
   * 含まれる場合に VaultScreen から渡され、差分表示 + 上書き/取り込みで解決する。
   */
  syncConflict?: VaultSyncConflict | null;
  /** 同期衝突の解決が完了したときに呼ばれる（パス。VaultScreen が一覧から除去する） */
  onSyncConflictResolved?: (path: string) => void;
}

/**
 * 本文内でスラグが一致する見出しの行番号（1 始まり）を返す。
 * リーディング表示の見出し id（slugify）と一致する規則で照合する。
 * 見つからない場合は null。
 */
function headingLineForSlug(content: string, slug: string): number | null {
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^#{1,6}\s+(.+)$/.exec(lines[index] ?? '');
    if (match && slugify((match[1] ?? '').trim()) === slug) {
      return index + 1;
    }
  }
  return null;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; note: NoteContent }
  | { kind: 'error'; message: string };

/** ペインの表示モード（Obsidian のパネル設定に倣いノート切替をまたいで保持する） */
type PaneMode = 'edit' | 'read';

/** 保存状態（表示用。conflict は別状態として持つ） */
type SaveStatus = 'clean' | 'dirty' | 'saving';

/** 競合状態（エディタはアンマウントされ、パネルで解決する） */
interface ConflictState {
  /** 保存に失敗した編集中の内容（スナップショット） */
  local: string;
  /** 競合検出後に再取得したリモートの内容 */
  remote: NoteContent;
}

export function NotePane({
  vaultRef,
  notePath,
  filePaths,
  pendingPath = null,
  notify,
  onSessionExpired,
  onNoteSaved,
  onNoteContentLoaded,
  onFileChanged,
  onPendingCommit,
  onPendingDiscard,
  onRenameNote,
  syncVersion = 0,
  syncConflict = null,
  onSyncConflictResolved,
}: NotePaneProps) {
  /** 未確定の新規ノートかどうか（URL パスと pending パスが一致する間だけ true） */
  const isPending = notePath === pendingPath;
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('clean');
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [draftNotice, setDraftNotice] = useState<Draft | null>(null);
  /** エディタの初期内容（競合解決・ノート切替で差し替える） */
  const [editorContent, setEditorContent] = useState<string>('');
  /** 表示/編集モード（Obsidian に倣いパネル単位で保持し、ノート切替では変えない） */
  const [mode, setMode] = useState<PaneMode>('edit');
  /**
   * インラインタイトル編集の状態。titleName は確定済みのタイトル（未確定ノート
   * の作成コミット名。拡張子なし）。titleEditing は編集モード中かどうか。
   */
  const [titleName, setTitleName] = useState('');
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const titleNameRef = useRef(titleName);
  titleNameRef.current = titleName;

  // イベントコールバックから最新値を読むための ref（レンダーを跨いで安定させる）
  const handleRef = useRef<EditorHandle | null>(null);
  const shaRef = useRef<string | null>(null);
  const contentRef = useRef<string>('');
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const conflictRef = useRef(false);
  const readyRef = useRef(false);
  /** setContent（プログラム的な本文置換）中の onChange を無視するためのフラグ */
  const programmaticRef = useRef(false);
  /**
   * load ごとのノート世代。進行中だった旧ノートの保存完了が新しいノートの
   * shaRef / dirty を上書きしないよう、保存結果の適用をこの世代でガードする
   * （ノート切替と保存のレース対策）。
   */
  const generationRef = useRef(0);
  /** タイトル編集入力にフォーカス中か（エディタ blur の自動保存を抑制する） */
  const titleEditingRef = useRef(false);
  /** タイトル編集へのクリック移動中のエディタ blur を抑制するフラグ */
  const suppressBlurRef = useRef(false);

  // オブジェクトの同一性ではなく値（owner / name）で依存を比較する
  const { owner, name } = vaultRef;

  const setDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
    setSaveStatus(dirty ? 'dirty' : 'clean');
  }, []);

  /**
   * 未保存の本文を Draft として退避する。
   * クラッシュ・誤クローズ・リロード時の復元を保証するため、本文が変わるたびに
   * 書き込む（localStorage への同期書き込みで、リロード直前の打鍵も失われない）。
   * localStorage が使えない環境では復元通知だけが無効になり、編集は継続できる。
   */
  const flushDraft = useCallback(
    (content: string): void => {
      // 未確定ノート（まだ存在しないパス）は Draft の対象外（Escape で破棄される）
      if (isPending) {
        return;
      }
      void run(saveDraft({ owner, name }, notePath, content)).catch(() => {});
    },
    [owner, name, notePath, isPending],
  );

  /**
   * URL ハッシュ（#スラグ）に対応する見出し行へエディタをスクロールする。
   * エディタ（ライブプレビュー）は本文をソース表示するため見出し id を持つ
   * DOM は存在せず、本文の見出し行をスラグで特定してスクロールする
   * （リーディング表示は ReadingView が同じ #スラグでスクロールする）。
   * 表示モードではエディタが非表示のため何もしない（ReadingView が担う）。
   */
  const scrollEditorToHash = useCallback((): void => {
    if (mode !== 'edit') {
      return;
    }
    const hash = window.location.hash;
    if (hash.length <= 1) {
      return;
    }
    const slug = decodeURIComponent(hash.slice(1));
    const line = headingLineForSlug(contentRef.current, slug);
    if (line !== null) {
      handleRef.current?.scrollToLine(line);
    }
  }, [mode]);

  const handleEditorReady = useCallback(
    (handle: EditorHandle | null) => {
      handleRef.current = handle;
      // ノート読み込み後にエディタが生成されるため、マウント時点のハッシュ遷移
      // （ディープリンク・WikiLink クリック）はここでもスクロールを試みる
      if (handle !== null) {
        scrollEditorToHash();
      }
    },
    [scrollEditorToHash],
  );

  // エディタモードでの #見出し 遷移: URL 変更イベントのたびに見出し行へ
  // スクロールする（リロード・SPA 遷移・同一ノート内遷移のすべてで動く）
  useEffect(() => {
    scrollEditorToHash();
    window.addEventListener('hashchange', scrollEditorToHash);
    window.addEventListener(NAVIGATE_EVENT_NAME, scrollEditorToHash);
    return () => {
      window.removeEventListener('hashchange', scrollEditorToHash);
      window.removeEventListener(NAVIGATE_EVENT_NAME, scrollEditorToHash);
    };
  }, [notePath, scrollEditorToHash]);

  /**
   * エディタ内の WikiLink クリック: SPA 内遷移（リーディング表示と同様の
   * URL 規則。`#見出し` はスラグ化して付与する）
   */
  const handleWikilinkClick = useCallback(
    (path: string, subpath: string | null) => {
      navigate(`${noteRoutePath(vaultRef, path)}${subpath !== null ? `#${slugify(subpath)}` : ''}`);
    },
    [vaultRef],
  );

  const handleContentChange = useCallback(
    (content: string) => {
      if (programmaticRef.current) {
        return;
      }
      contentRef.current = content;
      setDirty(true);
      flushDraft(content);
    },
    [setDirty, flushDraft],
  );

  /**
   * 画像のペースト / ドロップ時のアップロード（M2）。
   * File を base64 に変換して application 層の uploadImage（一括コミット）で
   * `attachments/` へ保存し、エディタが `![[パス]]` を挿入する。成功時はツリー
   * 再読込（onFileChanged）を依頼して Embed 解決・ツリー表示へ反映する。
   * 失敗はトーストで通知し null を返す（エディタは本文を変更しない）。
   */
  const handleUploadImage = useCallback(
    async (file: File): Promise<string | null> => {
      try {
        const base64 = await fileToBase64(file);
        const result = await run(
          uploadImage({ owner, name }, { fileName: imageFileName(file), base64 }),
        );
        notify('画像をアップロードしました。');
        onFileChanged?.();
        return result.path;
      } catch (error) {
        if (isSessionExpiredError(error)) {
          notify('セッションの有効期限が切れました。ログインし直してください。');
          onSessionExpired();
          return null;
        }
        notify(fileErrorMessage(error));
        return null;
      }
    },
    [owner, name, notify, onSessionExpired, onFileChanged],
  );

  /**
   * 競合検出 → Conflict 状態へ遷移する。リモートの最新内容を再取得して
   * 差分表示（2 ペイン）に使う。再取得に失敗したらトースト + リトライ。
   */
  const enterConflict = useCallback(
    async (local: string): Promise<void> => {
      try {
        const remote = await run(openNote({ owner, name }, notePath));
        conflictRef.current = true;
        setConflict({ local, remote });
        // 保存処理（saving）を解除する。表示は conflict により「競合」になる
        setSaveStatus('dirty');
      } catch (error) {
        if (isSessionExpiredError(error)) {
          notify('セッションの有効期限が切れました。ログインし直してください。');
          onSessionExpired();
          return;
        }
        notify(noteErrorMessage(error), {
          label: '再試行',
          onClick: () => void enterConflict(local),
        });
      }
    },
    [owner, name, notePath, notify, onSessionExpired],
  );

  /**
   * 保存を実行する（明示保存・自動保存の共通経路）。
   * 未確定ノートは create を 1 回だけ行う（Q15:2: タイトル確定時・自動保存時に
   * 最終名で 1 コミット）。通常ノートは未保存の変更がある場合のみコミットする。
   */
  const performSave = useCallback(
    async (content: string): Promise<void> => {
      if (savingRef.current || conflictRef.current || !readyRef.current) {
        return;
      }
      if (isPending) {
        savingRef.current = true;
        setSaveStatus('saving');
        const finalName = titleNameRef.current;
        try {
          const ok = await onPendingCommit?.(finalName, content);
          savingRef.current = false;
          if (ok === true) {
            // コミット成功後は VaultScreen が pending を解除して再読込する
            setDirty(false);
          } else {
            setSaveStatus('dirty');
          }
        } catch (error) {
          savingRef.current = false;
          setSaveStatus('dirty');
          notify(fileErrorMessage(error));
        }
        return;
      }
      if (!dirtyRef.current) {
        return;
      }
      savingRef.current = true;
      setSaveStatus('saving');
      const generation = generationRef.current;
      try {
        const result = await run(
          saveNoteContent({ owner, name }, notePath, { content, baseSha: shaRef.current }),
        );
        // サーバーの状態は変わったため、ノート切替レースの世代ガードより先に
        // 索引キャッシュへ反映する（再取得なしで最新化する）
        onNoteSaved?.(notePath, content);
        if (generation !== generationRef.current) {
          // 保存中にノートが切り替わった: 旧ノートの結果を新しいノートへ適用しない
          return;
        }
        shaRef.current = result.sha;
        await run(clearDraft({ owner, name }, notePath)).catch(() => {});
        // 保存成功で復元通知を閉じる（失敗時は閉じない。失敗時は内容がまだ残っており
        // 「復元」で誤って巻き戻るのを防ぐ）
        setDraftNotice(null);
        savingRef.current = false;
        setDirty(false);
      } catch (error) {
        if (generation !== generationRef.current) {
          return;
        }
        savingRef.current = false;
        if (isSessionExpiredError(error)) {
          notify('セッションの有効期限が切れました。ログインし直してください。');
          onSessionExpired();
          setSaveStatus('dirty');
          return;
        }
        if (error instanceof NoteSaveError && error.kind === 'conflict') {
          // リモート sha が読込時から変化: Conflict 状態へ遷移（データ損失は起こさない）
          await enterConflict(content);
          return;
        }
        const message = noteSaveErrorMessage(error);
        notify(message, {
          label: '再試行',
          onClick: () => void performSave(contentRef.current),
        });
        setSaveStatus('dirty');
      }
    },
    [
      isPending,
      onPendingCommit,
      owner,
      name,
      notePath,
      notify,
      onSessionExpired,
      setDirty,
      enterConflict,
      onNoteSaved,
    ],
  );

  // Cmd+S リスナーから最新の performSave を呼ぶための ref
  const performSaveRef = useRef(performSave);
  performSaveRef.current = performSave;

  /** 自動保存トリガー: エディタからのフォーカス喪失（単一ルール） */
  const handleEditorBlur = useCallback((): void => {
    if (draftNotice !== null) {
      // Draft 復元通知表示中の blur（「復元」「破棄」ボタンへのフォーカス移動を含む）では
      // 自動保存しない。通知に対する明示操作（破棄/復元）と矛盾するため
      return;
    }
    if (suppressBlurRef.current) {
      // タイトル編集へのクリック移動中（pointerdown で立てたフラグ）は自動保存しない
      suppressBlurRef.current = false;
      return;
    }
    if (isPending) {
      // 未確定ノート: タイトル未編集なら Untitled.md として自動コミットする（Q18:1）
      if (!savingRef.current && readyRef.current) {
        void performSave(contentRef.current);
      }
      return;
    }
    if (!dirtyRef.current || savingRef.current || conflictRef.current || !readyRef.current) {
      return;
    }
    void performSave(contentRef.current);
  }, [performSave, draftNotice, isPending]);

  // Cmd+S / Ctrl+S ショートカット（エディタ内外を問わず有効）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void performSaveRef.current(contentRef.current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 未確定ノートの Escape 破棄（Q19: 何もコミットせず閉じる）
  useEffect(() => {
    if (!isPending) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onPendingDiscard?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isPending, onPendingDiscard]);

  /** インラインタイトルの編集を開始する（クリックで編集モードへ） */
  const startTitleEdit = useCallback((): void => {
    setTitleDraft(titleNameRef.current);
    setTitleError(null);
    titleEditingRef.current = true;
    setTitleEditing(true);
  }, []);

  /** タイトル編集の確定（Enter / blur。検証して作成 or リネームへ渡す） */
  const confirmTitleEdit = useCallback((): void => {
    const rawName = titleDraft.trim();
    const withExtension = rawName.toLowerCase().endsWith('.md') ? rawName : `${rawName}.md`;
    const error = validateEntryName(withExtension, true);
    if (error !== null) {
      setTitleError(error);
      return;
    }
    titleEditingRef.current = false;
    setTitleEditing(false);
    setTitleError(null);
    if (withExtension === `${titleNameRef.current}.md`) {
      return;
    }
    if (isPending) {
      // タイトル確定 = 最終名で 1 コミット（Q15:2）。本文は現在のエディタ内容を渡す
      titleNameRef.current = withExtension.replace(/\.md$/i, '');
      setTitleName(titleNameRef.current);
      void performSave(contentRef.current);
    } else {
      void onRenameNote?.(notePath, withExtension);
    }
  }, [isPending, titleDraft, notePath, performSave, onRenameNote]);

  /** タイトル編集のキャンセル（Escape） */
  const cancelTitleEdit = useCallback((): void => {
    titleEditingRef.current = false;
    setTitleEditing(false);
    setTitleError(null);
  }, []);

  /** 競合解決: 編集中の内容を最新 sha で上書き保存する */
  const handleOverwrite = async (): Promise<void> => {
    if (!conflict) {
      return;
    }
    savingRef.current = true;
    setSaveStatus('saving');
    const generation = generationRef.current;
    try {
      const result = await run(
        saveNoteContent({ owner, name }, notePath, {
          content: conflict.local,
          baseSha: conflict.remote.sha,
        }),
      );
      // 上書き保存成功: 索引キャッシュへ反映する（再取得なし）
      onNoteSaved?.(notePath, conflict.local);
      if (generation !== generationRef.current) {
        return;
      }
      shaRef.current = result.sha;
      await run(clearDraft({ owner, name }, notePath)).catch(() => {});
      setDraftNotice(null);
      contentRef.current = conflict.local;
      conflictRef.current = false;
      setConflict(null);
      setEditorContent(conflict.local);
      savingRef.current = false;
      setDirty(false);
    } catch (error) {
      if (generation !== generationRef.current) {
        return;
      }
      savingRef.current = false;
      if (isSessionExpiredError(error)) {
        notify('セッションの有効期限が切れました。ログインし直してください。');
        onSessionExpired();
        return;
      }
      if (error instanceof NoteSaveError && error.kind === 'conflict') {
        // 解決中にさらにリモートが変わった — 差分を更新して再選択させる
        await enterConflict(conflict.local);
        return;
      }
      const message = noteSaveErrorMessage(error);
      notify(message, { label: '再試行', onClick: () => void handleOverwrite() });
    }
  };

  /** 競合解決: リモートの内容を取り込み、編集中の変更を破棄する */
  const handleAdopt = async (): Promise<void> => {
    if (!conflict) {
      return;
    }
    const generation = generationRef.current;
    contentRef.current = conflict.remote.content;
    shaRef.current = conflict.remote.sha;
    // 取り込み後はリモート内容が現在の本文になるため索引キャッシュへ反映する
    onNoteSaved?.(notePath, conflict.remote.content);
    await run(clearDraft({ owner, name }, notePath)).catch(() => {});
    if (generation !== generationRef.current) {
      // 取り込み中にノートが切り替わった: 旧ノートの状態を新しいノートへ適用しない
      return;
    }
    conflictRef.current = false;
    setConflict(null);
    setEditorContent(conflict.remote.content);
    setDirty(false);
  };

  /** Draft 復元: 退避済みの本文をエディタに戻す（Draft は保存成功まで残す） */
  const handleRestoreDraft = async (): Promise<void> => {
    if (!draftNotice) {
      return;
    }
    programmaticRef.current = true;
    handleRef.current?.setContent(draftNotice.content);
    programmaticRef.current = false;
    contentRef.current = draftNotice.content;
    setDraftNotice(null);
    setDirty(true);
  };

  /** Draft 破棄: 退避済みの本文を捨て、リモートの内容のままにする */
  const handleDiscardDraft = async (): Promise<void> => {
    setDraftNotice(null);
    await run(clearDraft({ owner, name }, notePath)).catch(() => {});
    setDirty(false);
  };

  const load = useCallback(async (): Promise<void> => {
    // ノート切替レース対策: 世代を進める。進行中の旧ノート保存は完了時に世代が
    // 一致しないため、shaRef / dirty などの状態を新しいノートへ適用しない
    generationRef.current += 1;
    setLoadState({ kind: 'loading' });
    readyRef.current = false;
    savingRef.current = false;
    conflictRef.current = false;
    setConflict(null);
    setDraftNotice(null);
    setSaveStatus('clean');
    dirtyRef.current = false;
    handleRef.current = null;
    // 未確定の新規ノート: fetch せず空の本文で即 ready（タイトル編集で作成コミット）
    if (isPending) {
      const defaultName = pathBaseName(notePath).replace(/\.md$/i, '');
      shaRef.current = null;
      contentRef.current = '';
      setEditorContent('');
      setTitleName(defaultName);
      titleNameRef.current = defaultName;
      setTitleEditing(false);
      setTitleDraft('');
      setTitleError(null);
      onNoteContentLoaded?.('');
      readyRef.current = true;
      setLoadState({ kind: 'ready', note: { path: notePath, sha: '', content: '' } });
      return;
    }
    try {
      const note = await run(openNote({ owner, name }, notePath));
      shaRef.current = note.sha;
      contentRef.current = note.content;
      setEditorContent(note.content);
      setTitleName(pathBaseName(notePath).replace(/\.md$/i, ''));
      titleNameRef.current = pathBaseName(notePath).replace(/\.md$/i, '');
      setTitleEditing(false);
      setTitleDraft('');
      setTitleError(null);
      onNoteContentLoaded?.(note.content);
      readyRef.current = true;
      setLoadState({ kind: 'ready', note });
      // 未保存の変更（Draft）があれば復元通知を出す
      const draft = await run(loadDraft({ owner, name }, notePath)).catch(() => null);
      if (draft !== null) {
        setDraftNotice(draft);
      }
    } catch (error) {
      if (isSessionExpiredError(error)) {
        notify('セッションの有効期限が切れました。ログインし直してください。');
        onSessionExpired();
        return;
      }
      const message = noteErrorMessage(error);
      setLoadState({ kind: 'error', message });
      notify(message, { label: '再試行', onClick: () => void load() });
    }
  }, [owner, name, notePath, isPending, notify, onNoteContentLoaded, onSessionExpired]);

  // ノート切替時に旧ノートの本文が 1 フレーム表示されるのを防ぐため、load() の
  // loading 状態を paint 前に反映する（useEffect だと NoteEditor が key=notePath の
  // 新インスタンスを旧 editorContent で一度マウントしてしまう）
  useLayoutEffect(() => {
    void load();
  }, [load]);

  /**
   * 同期完了後の最新化（M5。完了条件 9）:
   * 未保存（dirty）でなければノートを再読み込みして同期後の内容へ更新する。
   * 編集中（未保存）の Note はエディタの内容を保持し、保存時に既存の
   * Conflict フロー（楽観ロック）で同期後の内容とマージされる。
   */
  const previousSyncVersion = useRef(syncVersion);
  useEffect(() => {
    if (syncVersion === previousSyncVersion.current) {
      return;
    }
    previousSyncVersion.current = syncVersion;
    // 初回（同期前）は何もしない。同期実行後のバージョン更新のみ処理する
    if (syncVersion === 0) {
      return;
    }
    if (dirtyRef.current || conflictRef.current || loadState.kind !== 'ready') {
      return;
    }
    void load();
  }, [syncVersion, load, loadState.kind]);

  /** 同期衝突の解決中フラグ（二重送信の防止） */
  const resolvingSyncConflictRef = useRef(false);

  /**
   * 同期衝突の解決: GitHub 側の内容を採用する（overwrite）。
   * サーバーが R2 を GitHub の現在内容で更新するため、エディタと sha を
   * 更新して整合させる。GitHub 側で削除されたノートは Vault ルートへ戻る。
   */
  const handleSyncConflictOverwrite = useCallback(async (): Promise<void> => {
    if (syncConflict === null || resolvingSyncConflictRef.current) {
      return;
    }
    resolvingSyncConflictRef.current = true;
    const generation = generationRef.current;
    try {
      const sha = await run(
        resolveVaultSyncConflict({ owner, name }, syncConflict.path, 'overwrite'),
      );
      if (syncConflict.remoteSha === null) {
        // GitHub 側で削除されたノートの削除を採用 → Vault ルートへ戻る
        onFileChanged?.();
        navigate(vaultRoutePath({ owner, name }));
        return;
      }
      if (generation !== generationRef.current) {
        return;
      }
      programmaticRef.current = true;
      handleRef.current?.setContent(syncConflict.remote);
      programmaticRef.current = false;
      contentRef.current = syncConflict.remote;
      shaRef.current = sha;
      onNoteSaved?.(syncConflict.path, syncConflict.remote);
      await run(clearDraft({ owner, name }, notePath)).catch(() => {});
      setDirty(false);
      resolvingSyncConflictRef.current = false;
      onSyncConflictResolved?.(syncConflict.path);
    } catch (error) {
      resolvingSyncConflictRef.current = false;
      if (isSessionExpiredError(error)) {
        notify('セッションの有効期限が切れました。ログインし直してください。');
        onSessionExpired();
        return;
      }
      notify(noteErrorMessage(error), {
        label: '再試行',
        onClick: () => void handleSyncConflictOverwrite(),
      });
    }
  }, [
    syncConflict,
    owner,
    name,
    onNoteSaved,
    notify,
    onSessionExpired,
    onFileChanged,
    onSyncConflictResolved,
    notePath,
    setDirty,
  ]);

  /**
   * 同期衝突の解決: ローカル側の内容を採用する（adopt）。
   * サーバーがローカル内容を GitHub へ反映するため、エディタはそのままで
   * sha だけ更新する（次の保存は R2 と整合する）。
   */
  const handleSyncConflictAdopt = useCallback(async (): Promise<void> => {
    if (syncConflict === null || resolvingSyncConflictRef.current) {
      return;
    }
    resolvingSyncConflictRef.current = true;
    const generation = generationRef.current;
    try {
      const sha = await run(resolveVaultSyncConflict({ owner, name }, syncConflict.path, 'adopt'));
      if (generation !== generationRef.current) {
        return;
      }
      shaRef.current = sha;
      onNoteSaved?.(syncConflict.path, contentRef.current);
      await run(clearDraft({ owner, name }, notePath)).catch(() => {});
      setDirty(false);
      resolvingSyncConflictRef.current = false;
      onSyncConflictResolved?.(syncConflict.path);
    } catch (error) {
      resolvingSyncConflictRef.current = false;
      if (isSessionExpiredError(error)) {
        notify('セッションの有効期限が切れました。ログインし直してください。');
        onSessionExpired();
        return;
      }
      notify(noteErrorMessage(error), {
        label: '再試行',
        onClick: () => void handleSyncConflictAdopt(),
      });
    }
  }, [
    syncConflict,
    owner,
    name,
    onNoteSaved,
    notify,
    onSessionExpired,
    onSyncConflictResolved,
    notePath,
    setDirty,
  ]);

  // 保存状態の表示（競合中は「競合」を最優先で出す。未確定ノートは未保存扱い）
  // 同期衝突は編集中（未保存）でない場合のみ表示する（編集中 Note の保護:
  // 保存時の既存 Conflict フローが同期後の内容とのマージを担う）
  const showSyncConflict =
    syncConflict !== null && conflict === null && !isPending && saveStatus !== 'dirty';
  const statusLabel = isPending
    ? saveStatus === 'saving'
      ? '作成中…'
      : '未保存'
    : conflict !== null || showSyncConflict
      ? '競合'
      : saveStatus === 'saving'
        ? '保存中…'
        : saveStatus === 'dirty'
          ? '未保存'
          : '保存済み';
  const statusKey = isPending
    ? saveStatus === 'saving'
      ? 'saving'
      : 'dirty'
    : conflict !== null || showSyncConflict
      ? 'conflict'
      : saveStatus;

  return (
    <div className="note-pane" data-mode={mode}>
      <header className="note-pane-header">
        <p className="note-pane-path" data-testid="note-path">
          {notePath}
        </p>
        <div className="note-mode-toggle" role="group" aria-label="ノートの表示モード">
          <button
            type="button"
            className={mode === 'read' ? 'is-active' : ''}
            data-testid="mode-read-button"
            aria-pressed={mode === 'read'}
            onClick={() => setMode('read')}
            disabled={loadState.kind !== 'ready' || conflict !== null || isPending}
          >
            表示
          </button>
          <button
            type="button"
            className={mode === 'edit' ? 'is-active' : ''}
            data-testid="mode-edit-button"
            aria-pressed={mode === 'edit'}
            onClick={() => setMode('edit')}
            disabled={loadState.kind !== 'ready' || conflict !== null}
          >
            編集
          </button>
        </div>
        <span className="save-status" data-testid="save-status" data-status={statusKey}>
          {statusLabel}
        </span>
        <button
          type="button"
          className="button-secondary note-save-button"
          data-testid="save-button"
          onClick={() => void performSave(contentRef.current)}
          disabled={saveStatus === 'saving' || conflict !== null || loadState.kind !== 'ready'}
        >
          {isPending
            ? saveStatus === 'saving'
              ? '作成中…'
              : '作成'
            : saveStatus === 'saving'
              ? '保存中…'
              : '保存'}
        </button>
      </header>
      {draftNotice && (
        <div className="draft-restore" data-testid="draft-restore" role="status">
          <p className="draft-restore-message">未保存の変更が復元されました。</p>
          <div className="draft-restore-actions">
            <button
              type="button"
              className="button-primary"
              data-testid="draft-restore-button"
              onClick={() => void handleRestoreDraft()}
            >
              復元
            </button>
            <button
              type="button"
              className="button-secondary"
              data-testid="draft-discard-button"
              onClick={() => void handleDiscardDraft()}
            >
              破棄
            </button>
          </div>
        </div>
      )}
      {loadState.kind === 'loading' && (
        <p className="app-placeholder" role="status">
          ノートを読み込み中…
        </p>
      )}
      {loadState.kind === 'error' && (
        <div className="error-panel">
          <p>{loadState.message}</p>
          <button type="button" className="button-secondary" onClick={() => void load()}>
            再試行
          </button>
        </div>
      )}
      {loadState.kind === 'ready' && conflict === null && !showSyncConflict && (
        <div className="note-pane-body" data-mode={mode}>
          {/* エディタはモード切替でアンマウントせず非表示に保つ（編集中の内容と
              未保存状態を維持するため。表示モードへの切替時に blur が走り、
              既存ルールどおり自動保存される） */}
          {mode === 'edit' &&
            (titleEditing ? (
              <div
                className="editor-inline-title-edit"
                onPointerDown={() => {
                  suppressBlurRef.current = true;
                }}
              >
                <input
                  type="text"
                  className="editor-inline-title-input"
                  data-testid="editor-title-input"
                  aria-label="ノートのタイトル"
                  value={titleDraft}
                  autoFocus
                  onChange={(event) => {
                    setTitleDraft(event.target.value);
                    setTitleError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      confirmTitleEdit();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      cancelTitleEdit();
                    }
                  }}
                  onBlur={() => {
                    if (titleEditingRef.current) {
                      confirmTitleEdit();
                    }
                  }}
                />
                {titleError !== null && (
                  <p className="file-tree-editor-error" role="alert">
                    {titleError}
                  </p>
                )}
              </div>
            ) : (
              <button
                type="button"
                className="editor-inline-title"
                data-testid="editor-title"
                onClick={startTitleEdit}
                aria-label="タイトルを編集"
                onPointerDown={() => {
                  suppressBlurRef.current = true;
                }}
              >
                {titleName}
              </button>
            ))}
          <NoteEditor
            key={notePath}
            notePath={notePath}
            initialContent={editorContent}
            filePaths={filePaths}
            onWikilinkClick={handleWikilinkClick}
            onUploadImage={handleUploadImage}
            onContentChange={handleContentChange}
            onBlur={handleEditorBlur}
            onReady={handleEditorReady}
          />
          {mode === 'read' && (
            <ReadingView
              key={notePath}
              vaultRef={vaultRef}
              notePath={notePath}
              content={contentRef.current}
              filePaths={filePaths}
              notify={notify}
              onSessionExpired={onSessionExpired}
            />
          )}
        </div>
      )}
      {conflict !== null && (
        <ConflictPanel
          local={conflict.local}
          remote={conflict.remote}
          saving={saveStatus === 'saving'}
          onOverwrite={() => void handleOverwrite()}
          onAdopt={() => void handleAdopt()}
        />
      )}
      {showSyncConflict && syncConflict !== null && (
        <ConflictPanel
          variant="sync"
          local={syncConflict.local}
          remote={{
            path: syncConflict.path,
            content: syncConflict.remote,
            sha: syncConflict.remoteSha,
          }}
          saving={resolvingSyncConflictRef.current}
          onOverwrite={() => void handleSyncConflictOverwrite()}
          onAdopt={() => void handleSyncConflictAdopt()}
        />
      )}
    </div>
  );
}
