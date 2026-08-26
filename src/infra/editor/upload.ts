/**
 * 画像のペースト / ドロップをエディタへ統合する（M2）。
 *
 * - paste: クリップボード内の画像をアップロードしてカーソル位置へ挿入する
 * - drop: ドロップ位置へ挿入する（画像ファイルのみ処理。他は既定動作に委ねる）
 * 画像が含まれないイベントは false を返し、通常のペースト/ドロップ動作を保つ
 * （既存のテキストペーストと衝突しない）。
 */

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/** dataTransfer / clipboardData に含まれる画像ファイルを抽出する（純関数。テスト用） */
export function imageFilesFrom(transfer: DataTransfer | null): File[] {
  if (transfer === null) {
    return [];
  }
  return Array.from(transfer.files).filter((file) => file.type.startsWith('image/'));
}

/** 複数画像の Embed 挿入スニペット（`![[パス]]` を改行区切りで連結する） */
export function imageEmbedSnippet(paths: readonly string[]): string {
  return paths.map((path) => `![[${path}]]`).join('\n');
}

/**
 * 画像をアップロードし、成功分の `![[パス]]` を position へ挿入する。
 * 失敗分は挿入しない（失敗通知はアップロード側が行う）。全滅時は本文を変えない。
 */
async function insertUploadedImages(
  view: EditorView,
  files: readonly File[],
  upload: (file: File) => Promise<string | null>,
  position: number,
): Promise<void> {
  // アップロードは独立なので並列で行う（Promise.all は投入順を保つ）
  const results = await Promise.all(files.map((file) => upload(file)));
  const paths = results.filter((path): path is string => path !== null);
  if (paths.length === 0) {
    return;
  }
  const snippet = imageEmbedSnippet(paths);
  view.dispatch({
    changes: { from: position, insert: snippet },
    selection: { anchor: position + snippet.length },
  });
  view.focus();
}

/** 画像のペースト / ドロップハンドラを EditorView の dom event として登録する */
export function uploadExtension(onUploadImage: (file: File) => Promise<string | null>): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = imageFilesFrom(event.clipboardData);
      if (files.length === 0) {
        return false;
      }
      event.preventDefault();
      void insertUploadedImages(view, files, onUploadImage, view.state.selection.main.head);
      return true;
    },
    drop(event, view) {
      const files = imageFilesFrom(event.dataTransfer);
      if (files.length === 0) {
        return false;
      }
      event.preventDefault();
      // ドロップ位置へ挿入する（座標解決できない環境ではカーソル位置へ。レイアウト
      // 未確定のテスト環境などで posAtCoords が例外を投げることがあるため防御する）
      let position = view.state.selection.main.head;
      try {
        position = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? position;
      } catch {
        // カーソル位置のまま
      }
      void insertUploadedImages(view, files, onUploadImage, position);
      return true;
    },
  });
}
