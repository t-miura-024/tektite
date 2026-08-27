/**
 * ノート本文領域（インラインタイトル + CM6 エディタ + リーディング表示）。
 *
 * エディタはモード切替でアンマウントせず非表示に保つ（編集中の内容と未保存状態を
 * 維持するため。表示モードへの切替時に blur が走り、既存ルールどおり自動保存される）。
 */

import type { JSX, KeyboardEvent } from 'react';

import type { EditorHandle } from '@/composition';
import { NoteEditor } from '@/ui/components/note-editor';
import { ReadingView } from '@/ui/components/reading-view';
import { InlineTitleArea } from '@/ui/components/inline-title-area';
import type { NotePaneCore } from '@/ui/components/use-note-pane-core';

export type NotePaneBodyProps = {
  core: NotePaneCore;
  mode: 'edit' | 'read';
  /** タイトル編集の確定（Enter / blur 用の共通処理。親で検証する） */
  confirmTitleEdit: () => void;
  cancelTitleEdit: () => void;
  startTitleEdit: () => void;
  events: {
    handleWikilinkClick: (path: string, subpath: string | null) => void;
    handleUploadImage: (file: File) => Promise<string | null>;
    handleContentChange: (content: string) => void;
    handleEditorBlur: () => void;
    handleEditorReady: (handle: EditorHandle | null) => void;
  };
};

export function NotePaneBody(props: NotePaneBodyProps): JSX.Element {
  const { core, mode, events } = props;
  const titleEditing = core.titleEditing;

  /** 入力内のキー操作（Enter 確定 / Escape キャンセル） */
  const handleTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      props.confirmTitleEdit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      props.cancelTitleEdit();
    }
  };

  /** blur 時の確定（「編集中のみ」というガードは元実装どおり ref で判断する） */
  const handleTitleBlur = (): void => {
    if (core.titleEditingRef.current) {
      props.confirmTitleEdit();
    }
  };

  return (
    <div className="note-pane-body" data-mode={mode}>
      {mode === 'edit' && (
        <InlineTitleArea
          titleName={core.titleName}
          editing={titleEditing}
          titleDraft={core.titleDraft}
          titleError={core.titleError}
          onEditStart={props.startTitleEdit}
          onDraftChange={(draft) => {
            core.setTitleDraft(draft);
            core.setTitleError(null);
          }}
          handleKeyDown={handleTitleKeyDown}
          handleBlur={handleTitleBlur}
          onSuppressBlur={() => {
            core.suppressBlurRef.current = true;
          }}
        />
      )}
      <NoteEditor
        key={core.notePath}
        notePath={core.notePath}
        initialContent={core.editorContent}
        filePaths={core.props.filePaths}
        onWikilinkClick={events.handleWikilinkClick}
        onUploadImage={events.handleUploadImage}
        onContentChange={events.handleContentChange}
        onBlur={events.handleEditorBlur}
        onReady={events.handleEditorReady}
      />
      {mode === 'read' && (
        <ReadingView
          key={core.notePath}
          vaultRef={core.vaultRef}
          notePath={core.notePath}
          content={core.contentRef.current}
          filePaths={core.props.filePaths}
          notify={core.notify}
          onSessionExpired={core.onSessionExpired}
        />
      )}
    </div>
  );
}
