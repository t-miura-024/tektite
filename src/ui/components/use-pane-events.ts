/**
 * NotePane のイベント系コールバック（WikiLink 遷移・画像アップロード・本文変更・
 * エディタ生成/破棄・#見出し スクロール）を担うフック。
 */

import { useCallback, useEffect } from 'react';

import { uploadImage } from '@/application/file';
import { run, slugify, type EditorHandle } from '@/composition';
import type { PaneMode, NotePaneCore } from '@/ui/components/use-note-pane-core';
import { navigate, noteRoutePath, NAVIGATE_EVENT_NAME } from '@/ui/router';
import { fileToBase64, imageFileName } from '@/ui/image-upload';
import { fileErrorMessage } from '@/ui/note-error';
import { isSessionExpiredError } from '@/ui/vault-error';

export type PaneEventCallbacks = {
  /** エディタ内の WikiLink クリック: SPA 内遷移（#見出し はスラグ化して付与） */
  handleWikilinkClick: (path: string, subpath: string | null) => void;
  /** 画像のペースト / ドロップ時のアップロード（M2）。成功で Vault 内パス */
  handleUploadImage: (file: File) => Promise<string | null>;
  /** 本文が変わるたびに呼ばれる（未保存判定・Draft 退避のトリガー） */
  handleContentChange: (content: string) => void;
  /** エディタ生成（handle）/ 破棄（null）時に呼ばれる */
  handleEditorReady: (handle: EditorHandle | null) => void;
};

export function usePaneEvents(
  core: NotePaneCore,
  mode: PaneMode,
  flushDraft: (content: string) => void,
): PaneEventCallbacks {
  const {
    owner,
    name,
    notePath,
    vaultRef,
    notify,
    onSessionExpired,
    props,
    contentRef,
    programmaticRef,
    setDirty,
    handleRef,
  } = core;

  // エディタ内の WikiLink クリック: SPA 内遷移（リーディング表示と同様の URL 規則）
  const handleWikilinkClick = useCallback(
    (path: string, subpath: string | null): void => {
      navigate(`${noteRoutePath(vaultRef, path)}${subpath !== null ? `#${slugify(subpath)}` : ''}`);
    },
    [vaultRef],
  );

  /**
   * 画像のペースト / ドロップ時のアップロード（M2）。
   * 失敗はトースト通知して null を返す（エディタは本文を変更しない）。
   */
  const handleUploadImage = useCallback(
    async (file: File): Promise<string | null> =>
      uploadAndNotify(file, { owner, name }, notify, onSessionExpired, props.onFileChanged),
    [owner, name, notify, onSessionExpired, props],
  );

  const handleContentChange = useCallback(
    (content: string): void => {
      if (programmaticRef.current) {
        return;
      }
      contentRef.current = content;
      setDirty(true);
      flushDraft(content);
    },
    [programmaticRef, contentRef, setDirty, flushDraft],
  );

  // URL ハッシュ（#スラグ）に対応する見出し行へスクロール（表示モードでは何もしない）
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
  }, [mode, contentRef, handleRef]);

  // マウント時点のハッシュ遷移（ディープリンク・WikiLink クリック）にも対応
  const handleEditorReady = useCallback(
    (handle: EditorHandle | null): void => {
      handleRef.current = handle;
      if (handle !== null) {
        scrollEditorToHash();
      }
    },
    [handleRef, scrollEditorToHash],
  );

  useHeadingScrollEffect(notePath, scrollEditorToHash);

  return { handleWikilinkClick, handleUploadImage, handleContentChange, handleEditorReady };
}

/** エディタモードでの #見出し 遷移: URL 変更イベントのたびに見出し行へスクロールする */
function useHeadingScrollEffect(notePath: string, scrollToHash: () => void): void {
  useEffect(() => {
    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);
    window.addEventListener(NAVIGATE_EVENT_NAME, scrollToHash);
    return (): void => {
      window.removeEventListener('hashchange', scrollToHash);
      window.removeEventListener(NAVIGATE_EVENT_NAME, scrollToHash);
    };
  }, [notePath, scrollToHash]);
}

/** File を base64 変換して `attachments/` へ保存し、結果をトーストへ反映する */
async function uploadAndNotify(
  file: File,
  ref: { owner: string; name: string },
  notify: (message: string) => void,
  onSessionExpired: () => void,
  onFileChanged?: () => void,
): Promise<string | null> {
  try {
    const base64 = await fileToBase64(file);
    const result = await run(uploadImage(ref, { fileName: imageFileName(file), base64 }));
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
}

/**
 * 本文内でスラグが一致する見出しの行番号（1 始まり）を返す。
 * リーディング表示の見出し id（slugify）と一致する規則で照合する。見つからなければ null。
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
