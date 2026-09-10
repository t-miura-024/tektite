/**
 * CodeMirror 6 エディタのセットアップ。
 * 基本機能にライブプレビュー装飾を組み込む（ソース編集のまま装飾する）。
 * UI 層は infra を直接 import せず、src/composition 経由で EditorHandle を使う。
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';

import { markdownDecoration } from '@/infra/editor/markdown-decoration';
import { markdownDecorationTheme } from '@/infra/editor/markdown-decoration-theme';
import { uploadExtension } from '@/infra/editor/upload';
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
export type EditorOptions = {
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
};

/**
 * 生成したエディタの不透明なハンドル（UI 層は CM6 の型を知らない）。
 * 本文の読み書きとイベント購読（自動保存・未保存判定用）を提供する。
 */
export type EditorHandle = {
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
};

/** アプリの CSS 変数に追従するエディタテーマ */
const editorTheme = (dark: boolean): Extension =>
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
      editorTheme(
        ((): boolean => {
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
        })(),
      ),
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
    destroy: (): void => view.destroy(),
    getContent: (): string => view.state.doc.toString(),
    setContent: (content: string): void => {
      const current = view.state.doc.toString();
      if (current === content) {
        return;
      }
      view.dispatch({ changes: { from: 0, to: current.length, insert: content } });
    },
    scrollToLine: (line: number): void => {
      const document = view.state.doc;
      const clamped = Math.min(Math.max(1, line), document.lines);
      const pos = document.line(clamped).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'start' }),
      });
    },
    updateFilePaths: (filePaths: readonly string[]): void => {
      view.dispatch({
        effects: filePathsCompartment.reconfigure(
          buildNotationExtensions({ ...options, filePaths }),
        ),
      });
    },
    onBlur: (callback: () => void): void => {
      blurCallbacks.add(callback);
    },
    onChange: (callback: (content: string) => void): void => {
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
