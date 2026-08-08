import { describe, expect, it } from 'vitest';

import { buildEditorState } from '@/infra/editor/editor';

describe('CM6 エディタセットアップ（状態生成）', () => {
  it('本文を保持した編集可能な状態を組み立てる', () => {
    const state = buildEditorState('# 見出し\n\n- リスト');
    expect(state.doc.toString()).toBe('# 見出し\n\n- リスト');
    expect(state.doc.lines).toBe(3);
  });

  it('更新で本文を変更できる（編集が機能する）', () => {
    const state = buildEditorState('hello');
    const next = state.update({ changes: { from: 0, insert: 'world ' } });
    expect(next.state.doc.toString()).toBe('world hello');
  });
});
