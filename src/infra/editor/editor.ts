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
import { EditorView, keymap, lineNumbers } from '@codemirror/view';

import { markdownDecoration, markdownDecorationTheme } from '@/infra/editor/markdown-decoration';

/** 生成したエディタの不透明なハンドル（UI 層は CM6 の型を知らない） */
export interface EditorHandle {
  readonly destroy: () => void;
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
export function buildEditorState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdownDecoration,
      markdownDecorationTheme,
      lineNumbers(),
      EditorView.lineWrapping,
      editorTheme(isDarkMode()),
    ],
  });
}

/** 親要素に CM6 エディタを生成する（破棄はハンドル経由） */
export function createEditorView(parent: HTMLElement, doc: string): EditorHandle {
  const view = new EditorView({ state: buildEditorState(doc), parent });
  return {
    destroy: () => view.destroy(),
  };
}
