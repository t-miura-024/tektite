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
import { EditorState } from '@codemirror/state';
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
 */
export interface EditorOptions {
  /** Vault 内の全ファイルパス（未指定なら記法装飾を組み込まない） */
  readonly filePaths?: readonly string[];
  /** WikiLink クリック時の遷移コールバック（ターゲットが解決できた場合のみ） */
  readonly onWikilinkClick?: (path: string, subpath: string | null) => void;
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

  const view = new EditorView({
    state: buildEditorState(
      doc,
      [
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const content = update.state.doc.toString();
            for (const callback of changeCallbacks) {
              callback(content);
            }
          }
        }),
      ],
      options,
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
    onBlur: (callback) => {
      blurCallbacks.add(callback);
    },
    onChange: (callback) => {
      changeCallbacks.add(callback);
    },
  };
}
