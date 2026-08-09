/**
 * CodeMirror 6 エディタのセットアップ。
 *
 * 基本セットアップ（編集可能・行番号・折り返し・履歴）に、ライブプレビュー装飾
 * （markdownDecoration / markdownDecorationTheme）を組み込む。装飾は
 * src/domain/markdown の構文解析 + 自前の StateField によるインライン装飾で
 * 実現する（WYSIWYG の DOM 変換はしない。ソーステキストのまま編集できる）。
 *
 * 依存の向きの都合上、UI 層（src/ui）は infra を直接 import できない
 * （.oxlintrc.json で機械検査）。このモジュールは src/composition 経由で
 * UI に公開され、UI は opaque な EditorHandle だけを扱う（CM6 の型に触れない）。
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Compartment, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';

import { markdownDecoration, markdownDecorationTheme } from '@/infra/editor/markdown-decoration';
import {
  notationDecoration,
  notationDecorationTheme,
  resolveWikilinkAt,
} from '@/infra/editor/notation-decoration';

/**
 * エディタ生成時のオプション（M3 の記法装飾・WikiLink クリック遷移用）。
 * filePaths は Vault 内の全ファイルパスで、WikiLink / Embed / Tag の解決に使う。
 * onWikilinkClick は解決済みのリンク先（パス + 見出し）を通知するコールバック。
 * onUploadImage は画像のペースト/ドロップ時に呼ばれる（M2）。
 */
export interface EditorOptions {
  /** Vault 内の全ファイルパス（未指定なら記法装飾を組み込まない） */
  readonly filePaths?: readonly string[];
  /** WikiLink クリック時の遷移コールバック（ターゲットが解決できた場合のみ） */
  readonly onWikilinkClick?: (path: string, subpath: string | null) => void;
  /**
   * 画像のペースト / ドロップ時のアップロード。
   * 成功で Vault 内パス（例: attachments/...png）を返し、エディタが
   * `![[パス]]` を挿入する。失敗（アップロード側で通知済み）は null を返す。
   */
  readonly onUploadImage?: (file: File) => Promise<string | null>;
}

/**
 * 生成したエディタの不透明なハンドル（UI 層は CM6 の型を知らない）。
 * 本文の読み書きとイベント購読（自動保存・未保存判定用）を提供する。
 */
export interface EditorHandle {
  readonly destroy: () => void;
  /** 現在の本文を取得する */
  readonly getContent: () => string;
  /** 本文を置き換える（同一内容のときは何もしない。Draft 復元・競合解決用） */
  readonly setContent: (content: string) => void;
  /**
   * 指定行（1 始まり）へカーソルを移動してスクロールする。
   * エディタモードでの見出し遷移（#スラグ付き WikiLink クリック）に使う。
   * 行番号は 1..最終行 にクランプする。
   */
  readonly scrollToLine: (line: number) => void;
  /**
   * Vault 内の全ファイルパスを差し替える（エディタ再生成なしで記法装飾と
   * WikiLink 解決を更新する。画像アップロード後のツリー再読込で使う）。
   */
  readonly updateFilePaths: (filePaths: readonly string[]) => void;
  /**
   * フォーカス喪失の通知を購読する。エディタ外へのフォーカス移動・ウィンドウ
   * blur・エディタ破棄を問わない「エディタからのフォーカス喪失すべて」が
   * 単一ルールで通知される（自動保存のトリガー）。
   */
  readonly onBlur: (callback: () => void) => void;
  /** 本文変更の通知を購読する（未保存判定と Draft 退避のトリガー） */
  readonly onChange: (callback: (content: string) => void) => void;
}

/** システム / アプリ設定のダークモード判定（CM6 のテーマ配色選択用） */
function isDarkMode(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme === 'dark') {
    return true;
  }
  if (theme === 'light') {
    return false;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** アプリの CSS 変数に追従するエディタテーマ */
const editorTheme = (dark: boolean) =>
  EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: '0.9375rem',
        backgroundColor: 'transparent',
        color: 'var(--color-fg)',
      },
      '.cm-scroller': {
        fontFamily: 'var(--font-sans)',
        lineHeight: 1.7,
      },
      '.cm-content': {
        caretColor: 'var(--color-fg)',
        padding: 'var(--space-sm) 0',
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-cursor': {
        borderLeftColor: 'var(--color-accent)',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'color-mix(in srgb, var(--color-accent) 25%, transparent)',
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        border: 'none',
        color: 'var(--color-fg-muted)',
      },
      '.cm-activeLine': {
        backgroundColor: 'var(--color-bg-subtle)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--color-fg)',
      },
    },
    { dark },
  );

/** エディタ状態を組み立てる（DOM に依存しない純粋関数。テスト用に分離） */
export function buildEditorState(
  doc: string,
  extraExtensions: readonly Extension[] = [],
  options: EditorOptions = {},
): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdownDecoration,
      markdownDecorationTheme,
      // 記法装飾（WikiLink / Embed / Tag）は filePaths があれば組み込む
      ...(options.filePaths !== undefined
        ? [notationDecoration(options.filePaths), notationDecorationTheme]
        : []),
      // WikiLink クリック遷移（filePaths とコールバックの両方が揃ったときのみ）
      ...(options.filePaths !== undefined && options.onWikilinkClick !== undefined
        ? [wikilinkClickExtension(options)]
        : []),
      lineNumbers(),
      EditorView.lineWrapping,
      editorTheme(isDarkMode()),
      ...extraExtensions,
    ],
  });
}

/**
 * WikiLink クリックの検知 extension。
 * 修飾キーなしの左クリックで、クリック位置が解決可能な WikiLink 内にあれば
 * onWikilinkClick を呼ぶ（mousedown と同位置のクリックのみ。ドラッグ選択は除外）。
 * 修飾キー付きクリックは何もしない（エディタのカーソル配置を許可する）。
 */
function wikilinkClickExtension(options: EditorOptions): Extension {
  let downPos: number | null = null;
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      downPos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    },
    click(event, view) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null || pos !== downPos) {
        return;
      }
      const filePaths = options.filePaths;
      const onNavigate = options.onWikilinkClick;
      if (!filePaths || !onNavigate) {
        return;
      }
      const resolved = resolveWikilinkAt(view.state.doc.toString(), pos, filePaths);
      if (resolved === null) {
        return;
      }
      event.preventDefault();
      onNavigate(resolved.path, resolved.subpath);
    },
  });
}

/** 親要素に CM6 エディタを生成する（破棄はハンドル経由） */
export function createEditorView(
  parent: HTMLElement,
  doc: string,
  options: EditorOptions = {},
): EditorHandle {
  const blurCallbacks = new Set<() => void>();
  const changeCallbacks = new Set<(content: string) => void>();

  // 記法装飾（WikiLink / Embed / Tag）と WikiLink クリック遷移は filePaths に依存する。
  // エディタ再生成（編集中の本文が失われる）を避けるため Compartment に入れ、
  // updateFilePaths で動的に再構成する（画像アップロード後の Embed 解決用）
  const filePathsCompartment = new Compartment();
  const view = new EditorView({
    state: buildEditorState(
      doc,
      [
        filePathsCompartment.of(buildNotationExtensions(options)),
        ...(options.onUploadImage !== undefined ? [uploadExtension(options.onUploadImage)] : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const content = update.state.doc.toString();
            for (const callback of changeCallbacks) {
              callback(content);
            }
          }
        }),
      ],
      // 静的 filePaths 経由の記法装飾は上記 Compartment 側で入れるため無効化する
      { ...options, filePaths: undefined, onWikilinkClick: undefined },
    ),
    parent,
  });

  // フォーカス喪失の検知。blur はバブルしないため focusout（バブルする）を使う。
  // エディタ内でのフォーカス移動（将来の focusable な widget 等）は喪失とみなさない。
  view.dom.addEventListener('focusout', (event) => {
    const related = event.relatedTarget;
    if (related instanceof Node && view.dom.contains(related)) {
      return;
    }
    for (const callback of blurCallbacks) {
      callback();
    }
  });

  return {
    destroy: () => view.destroy(),
    getContent: () => view.state.doc.toString(),
    setContent: (content: string) => {
      const current = view.state.doc.toString();
      if (current === content) {
        return;
      }
      view.dispatch({ changes: { from: 0, to: current.length, insert: content } });
    },
    scrollToLine: (line: number) => {
      const document = view.state.doc;
      const clamped = Math.min(Math.max(1, line), document.lines);
      const pos = document.line(clamped).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'start' }),
      });
    },
    updateFilePaths: (filePaths) => {
      view.dispatch({
        effects: filePathsCompartment.reconfigure(
          buildNotationExtensions({ ...options, filePaths }),
        ),
      });
    },
    onBlur: (callback) => {
      blurCallbacks.add(callback);
    },
    onChange: (callback) => {
      changeCallbacks.add(callback);
    },
  };
}

/** filePaths に依存する記法装飾 + WikiLink クリック遷移の extension 列を組み立てる */
function buildNotationExtensions(options: EditorOptions): Extension[] {
  if (options.filePaths === undefined) {
    return [];
  }
  const extensions: Extension[] = [notationDecoration(options.filePaths), notationDecorationTheme];
  if (options.onWikilinkClick !== undefined) {
    extensions.push(wikilinkClickExtension(options));
  }
  return extensions;
}

/** dataTransfer / clipboardData に含まれる画像ファイルを抽出する（純関数。テスト用） */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (data === null) {
    return [];
  }
  return Array.from(data.files).filter((file) => file.type.startsWith('image/'));
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

/**
 * 画像のペースト / ドロップを検知する extension（M2）。
 * - paste: クリップボード内の画像をアップロードしてカーソル位置へ挿入する
 * - drop: ドロップ位置へ挿入する（画像ファイルのみ処理。他は既定動作に委ねる）
 * 画像が含まれないイベントは false を返し、通常のペースト/ドロップ動作を保つ
 * （既存のテキストペーストと衝突しない）。
 */
function uploadExtension(onUploadImage: (file: File) => Promise<string | null>): Extension {
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
