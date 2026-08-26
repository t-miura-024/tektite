/**
 * ノートペイン（Vault 内画面のメインペイン。選択中ノートの表示と編集）。
 *
 * M1/M2 のノート読み込み・CM6 エディタ表示に加え、M3 の保存パイプラインを担う:
 *
 * - 明示保存: 保存ボタン + Cmd+S / Ctrl+S
 * - 保存状態表示: 未保存 / 保存中… / 保存済み / 競合
 * - 自動保存: エディタからのフォーカス喪失すべて（単一ルール）
 * - 競合: 「差分表示 + 上書き / 取り込み」で解決する（自動マージなし）
 * - Draft: 本文が変わるたびに退避し、復元 / 破棄を選ばせる。保存成功で削除
 *
 * 状態とロジックは useNotePaneCore と各フィーチャーフックに集約し、
 * このコンポーネントは組み立てだけを担う。
 */

import { useEffect, useState, type JSX } from 'react';

import type { VaultSyncConflict } from '@/application/vault';

import { ConflictPanel } from '@/ui/components/conflict-panel';
import { DraftRestoreBanner } from '@/ui/components/draft-restore-banner';
import { NotePaneBody } from '@/ui/components/note-pane-body';
import { NotePaneHeader } from '@/ui/components/note-pane-header';
import { NotePaneStateViews } from '@/ui/components/note-pane-state-views';
import {
  useNotePaneCore,
  type ConflictState,
  type NotePaneProps,
  type PaneMode,
} from '@/ui/components/use-note-pane-core';
import { useNoteLoad } from '@/ui/components/use-note-load';
import { useNoteSave } from '@/ui/components/use-note-save';
import { usePaneEvents } from '@/ui/components/use-pane-events';
import { useSyncConflictResolution } from '@/ui/components/use-sync-conflict-resolution';
import { useTitleEditor } from '@/ui/components/use-title-editor';

/** 未確定ノートの Escape 破棄（Q19: 何もコミットせず閉じる） */
function usePendingDiscard(isPending: boolean, onPendingDiscard?: () => void): void {
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
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, [isPending, onPendingDiscard]);
}

export function NotePane(props: NotePaneProps): JSX.Element {
  const core = useNotePaneCore(props);
  const save = useNoteSave(core);
  const { load } = useNoteLoad(core);
  const title = useTitleEditor(core, save.performSave);
  const syncResolve = useSyncConflictResolution(core);
  const [mode, setMode] = useState<PaneMode>('edit');
  const events = usePaneEvents(core, mode, save.flushDraft);

  // 未確定ノートの Escape 破棄（Q19）
  usePendingDiscard(core.isPending, props.onPendingDiscard);

  /**
   * 同期衝突は編集中（未保存）でない場合のみ表示する（編集中 Note の保護:
   * 保存時の既存 Conflict フローが同期後の内容とのマージを担う）
   */
  const showSyncConflict =
    core.syncConflict !== null &&
    core.conflict === null &&
    !core.isPending &&
    core.saveStatus !== 'dirty';

  return (
    <div className="note-pane" data-mode={mode}>
      <NotePaneHeader
        notePath={core.notePath}
        mode={mode}
        setMode={setMode}
        isPending={core.isPending}
        saveStatus={core.saveStatus}
        conflictActive={core.conflict !== null}
        syncConflictShown={showSyncConflict}
        loadReady={core.loadState.kind === 'ready'}
        onSave={() => void save.performSave(core.contentRef.current)}
      />
      {core.draftNotice !== null && (
        <DraftRestoreBanner
          onRestore={save.restoreDraft}
          onDiscard={() => void save.discardDraft()}
        />
      )}
      <NotePaneStateViews loadState={core.loadState} onRetry={() => void load()} />
      {core.loadState.kind === 'ready' && core.conflict === null && !showSyncConflict && (
        <NotePaneBody
          core={core}
          mode={mode}
          confirmTitleEdit={title.confirmTitleEdit}
          cancelTitleEdit={title.cancelTitleEdit}
          startTitleEdit={title.startTitleEdit}
          events={{ ...events, handleEditorBlur: save.handleEditorBlur }}
        />
      )}
      <ConflictPanels
        conflict={core.conflict}
        showSyncConflict={showSyncConflict}
        syncConflict={core.syncConflict}
        saving={core.saveStatus === 'saving'}
        resolving={syncResolve.isResolving()}
        onOverwrite={() => void save.handleOverwrite()}
        onAdopt={() => void save.handleAdopt()}
        onSyncOverwrite={() => void syncResolve.resolveOverwrite()}
        onSyncAdopt={() => void syncResolve.resolveAdopt()}
      />
    </div>
  );
}

type ConflictPanelsProps = {
  conflict: ConflictState | null;
  showSyncConflict: boolean;
  syncConflict: VaultSyncConflict | null;
  saving: boolean;
  resolving: boolean;
  onOverwrite: () => void;
  onAdopt: () => void;
  onSyncOverwrite: () => void;
  onSyncAdopt: () => void;
};

/** 保存時競合と同期衝突の両パネル（同じ「差分 + 二者択一」UI を共用） */
function ConflictPanels(props: ConflictPanelsProps): JSX.Element | null {
  const {
    conflict,
    showSyncConflict,
    syncConflict,
    saving,
    resolving,
    onOverwrite,
    onAdopt,
    onSyncOverwrite,
    onSyncAdopt,
  } = props;
  return (
    <>
      {conflict !== null && (
        <ConflictPanel
          local={conflict.local}
          remote={conflict.remote}
          saving={saving}
          onOverwrite={onOverwrite}
          onAdopt={onAdopt}
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
          saving={resolving}
          onOverwrite={onSyncOverwrite}
          onAdopt={onSyncAdopt}
        />
      )}
    </>
  );
}
