/**
 * ライブプレビュー装飾のスタイル（EditorView.baseTheme）。
 * アプリの CSS 変数に追従しダークモードでも整合する。
 */

import { EditorView } from '@codemirror/view';

/** 装飾クラスのスタイル定義 */
export const markdownDecorationTheme = EditorView.baseTheme({
  '.tk-html-comment': { color: '#6272a4' },
  '.tk-heading-marker': { color: 'var(--color-fg-muted)' },
  '.tk-heading': { fontWeight: '700', color: 'var(--color-fg)' },
  '.tk-heading-1': { fontSize: '1.6em', lineHeight: 1.25 },
  '.tk-heading-2': { fontSize: '1.4em', lineHeight: 1.3 },
  '.tk-heading-3': { fontSize: '1.2em', lineHeight: 1.35 },
  '.tk-heading-4': { fontSize: '1.05em' },
  '.tk-heading-5': { fontSize: '1em' },
  '.tk-heading-6': { fontSize: '0.95em', color: 'var(--color-fg-muted)' },
  '.tk-bold': { fontWeight: '800' },
  '.tk-italic': { fontStyle: 'italic' },
  '.tk-bold-italic': { fontWeight: '800', fontStyle: 'italic' },
  '.tk-inline-code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.875em',
    backgroundColor: 'var(--color-bg-subtle)',
    borderRadius: '4px',
    padding: '0.1em 0.35em',
  },
  '.tk-code-block': {
    display: 'block',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.875em',
    backgroundColor: 'var(--color-bg-subtle)',
    padding: '0 0.75em',
  },
  '.tk-code-fence': {
    display: 'block',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.875em',
    backgroundColor: 'var(--color-bg-subtle)',
    color: 'var(--color-fg-muted)',
    padding: '0 0.75em',
  },
  '.tk-list-marker': { color: 'var(--color-fg-muted)' },
  '.tk-task-marker': { color: 'var(--color-fg-muted)' },
  '.tk-task-checkbox': {
    display: 'inline-block',
    width: '0.95em',
    height: '0.95em',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    backgroundColor: 'var(--color-bg)',
    marginRight: '0.35em',
    verticalAlign: '-0.1em',
  },
  '.tk-task-checkbox.checked': {
    backgroundColor: 'var(--color-accent)',
    borderColor: 'var(--color-accent)',
  },
  '.tk-quote': {
    borderLeft: '3px solid var(--color-border)',
    paddingLeft: 'var(--space-md)',
    color: 'var(--color-fg-muted)',
  },
  '.tk-quote-marker': { color: 'var(--color-fg-muted)' },
  '.tk-link': { color: 'var(--color-accent)', textDecoration: 'underline' },
  '.tk-link-url': { color: 'var(--color-fg-muted)' },
  '.tk-hr': {
    display: 'block',
    height: '1px',
    backgroundColor: 'var(--color-border)',
    color: 'transparent',
  },
});
