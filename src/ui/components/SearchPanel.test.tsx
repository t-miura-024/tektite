/**
 * 全文検索パネルの UI ロジックテスト（M4: M2 検索 UI）。
 *
 * 既存のテスト環境は node のため、このファイルはファイル先頭の
 * @vitest-environment ディレクティブで jsdom に切り替えて検証する。
 * 検索・選択・キー操作・遷移（navigate → パス変化）をカバーする。
 *
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { createNoteSearcher } from '@/application/search';
import type { NoteSearcher } from '@/application/search';
import type { VaultRef } from '@/domain/vault';

import { SearchPanel } from '@/ui/components/SearchPanel';

const vaultRef: VaultRef = { owner: 'owner', name: 'repo' };

interface Rendered {
  container: HTMLElement;
  root: Root;
  input: HTMLInputElement;
}

async function renderPanel(
  searcher: NoteSearcher | null,
  onClose?: () => void,
  indexFailed = false,
  onRetry?: () => void,
): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SearchPanel
        vaultRef={vaultRef}
        searcher={searcher}
        indexFailed={indexFailed}
        onRetry={onRetry ?? (() => {})}
        onClose={onClose ?? (() => {})}
      />,
    );
  });
  const input = container.querySelector('input');
  if (input === null) {
    throw new Error('検索入力がありません');
  }
  return { container, root, input };
}

/** React の onChange を発火させる（React 19 はネイティブ value setter 経由の代入が必要） */
async function typeQuery(input: HTMLInputElement, query: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressKey(input: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function results(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="search-result"]')];
}

function selected(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="search-result"][aria-selected="true"]');
}

afterEach(() => {
  // テスト間でパスを共有しない（navigate の履歴をリセット）
  window.history.replaceState(null, '', '/');
});

describe('SearchPanel', () => {
  it('クエリ入力で結果一覧が表示される', async () => {
    const searcher = createNoteSearcher([
      { path: 'notes/alpha.md', content: 'アルファの本文', tags: [] },
      { path: 'notes/beta.md', content: 'ベータの本文', tags: [] },
    ]);
    const { container, root, input } = await renderPanel(searcher);
    await typeQuery(input, 'アルファ');
    const items = results(container);
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('alpha');
    root.unmount();
  });

  it('一致がない場合はメッセージを表示する', async () => {
    const searcher = createNoteSearcher([{ path: 'notes/alpha.md', content: '本文', tags: [] }]);
    const { container, root, input } = await renderPanel(searcher);
    await typeQuery(input, 'zzzz');
    expect(results(container)).toHaveLength(0);
    expect(container.textContent).toContain('一致するノートはありません');
    root.unmount();
  });

  it('索引未ロード（searcher null）の場合は読み込み中を表示する', async () => {
    const { container, root } = await renderPanel(null);
    expect(container.textContent).toContain('ノート索引を読み込み中…');
    root.unmount();
  });

  it('索引の読み込みに失敗した場合はエラーと再試行ボタンを表示する', async () => {
    let retried = false;
    const { container, root } = await renderPanel(
      null,
      () => {},
      true,
      () => {
        retried = true;
      },
    );
    expect(container.textContent).toContain('ノート索引を読み込めませんでした');
    const retry = container.querySelector('button');
    expect(retry?.textContent).toBe('再試行');
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(retried).toBe(true);
    root.unmount();
  });

  it('矢印キーで選択が移動する', async () => {
    const searcher = createNoteSearcher([
      { path: 'notes/alpha.md', content: '共通キーワード アルファ', tags: [] },
      { path: 'notes/beta.md', content: '共通キーワード ベータ', tags: [] },
    ]);
    const { container, root, input } = await renderPanel(searcher);
    await typeQuery(input, '共通');
    const items = results(container);
    expect(items.length).toBeGreaterThanOrEqual(2);
    // 初期選択は先頭の結果
    expect(selected(container)?.textContent).toBe(items[0]?.textContent);
    await pressKey(input, 'ArrowDown');
    expect(selected(container)?.textContent).toBe(items[1]?.textContent);
    await pressKey(input, 'ArrowUp');
    expect(selected(container)?.textContent).toBe(items[0]?.textContent);
    root.unmount();
  });

  it('Enter で選択中のノートを開きパネルを閉じる', async () => {
    const searcher = createNoteSearcher([
      { path: 'notes/alpha.md', content: 'アルファの本文', tags: [] },
    ]);
    let closed = false;
    const { root, input } = await renderPanel(searcher, () => {
      closed = true;
    });
    await typeQuery(input, 'アルファ');
    await pressKey(input, 'Enter');
    expect(window.location.pathname).toBe('/owner/repo/blob/notes/alpha.md');
    expect(closed).toBe(true);
    root.unmount();
  });

  it('IME 変換中の Enter（isComposing）はノートを開かない', async () => {
    const searcher = createNoteSearcher([
      { path: 'notes/alpha.md', content: 'アルファの本文', tags: [] },
    ]);
    let closed = false;
    const { root, input } = await renderPanel(searcher, () => {
      closed = true;
    });
    await typeQuery(input, 'アルファ');
    await act(async () => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      // jsdom は KeyboardEventInit の isComposing を反映しないため defineProperty で設定
      Object.defineProperty(event, 'isComposing', { value: true });
      input.dispatchEvent(event);
    });
    expect(window.location.pathname).toBe('/');
    expect(closed).toBe(false);
    root.unmount();
  });

  it('IME 変換確定時の Enter（keyCode 229）は一度スキップされる', async () => {
    const searcher = createNoteSearcher([
      { path: 'notes/alpha.md', content: 'アルファの本文', tags: [] },
    ]);
    let closed = false;
    const { root, input } = await renderPanel(searcher, () => {
      closed = true;
    });
    await typeQuery(input, 'アルファ');
    await act(async () => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      Object.defineProperty(event, 'keyCode', { value: 229 });
      input.dispatchEvent(event);
    });
    expect(window.location.pathname).toBe('/');
    expect(closed).toBe(false);
    root.unmount();
  });

  it('結果のクリックでノートを開く', async () => {
    const searcher = createNoteSearcher([
      { path: 'notes/alpha.md', content: 'アルファの本文', tags: [] },
    ]);
    const { container, root, input } = await renderPanel(searcher);
    await typeQuery(input, 'アルファ');
    const item = results(container)[0];
    expect(item).toBeDefined();
    await act(async () => {
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(window.location.pathname).toBe('/owner/repo/blob/notes/alpha.md');
    root.unmount();
  });

  it('Esc でパネルを閉じる', async () => {
    let closed = false;
    const { root, input } = await renderPanel(
      createNoteSearcher([{ path: 'notes/alpha.md', content: '本文', tags: [] }]),
      () => {
        closed = true;
      },
    );
    await pressKey(input, 'Escape');
    expect(closed).toBe(true);
    root.unmount();
  });

  it('Tab キーでフォーカスがパネル内に留まる', async () => {
    const { container, root, input } = await renderPanel(
      createNoteSearcher([{ path: 'notes/alpha.md', content: '本文', tags: [] }]),
    );
    input.focus();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    // フォーカス可能要素が入力のみの場合は入力へ戻る（背景へ抜けない）
    expect(document.activeElement).toBe(input);
    expect(container.contains(input)).toBe(true);
    root.unmount();
  });

  it('エラー表示時は Tab で入力と再試行ボタンの間を循環する', async () => {
    const { container, root, input } = await renderPanel(
      null,
      () => {},
      true,
      () => {},
    );
    const retry = container.querySelector('button');
    expect(retry).not.toBeNull();
    input.focus();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(retry);
    await act(async () => {
      retry!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(input);
    // Shift+Tab でも末尾から循環する
    input.focus();
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(retry);
    root.unmount();
  });

  it('結果表示は一致スニペットをハイライトする', async () => {
    const searcher = createNoteSearcher([
      { path: 'notes/alpha.md', content: '本文に キーワード を含む', tags: [] },
    ]);
    const { container, root, input } = await renderPanel(searcher);
    await typeQuery(input, 'キーワード');
    const marks = container.querySelectorAll('.search-result-snippet mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0]?.textContent).toBe('キーワード');
    root.unmount();
  });

  it('タグ一致の結果はタグ表示（.search-result-tag）を描画する', async () => {
    // 本文にタグ語を含まないノートのタグ一致（kind='tag'）で描画される
    const searcher = createNoteSearcher([
      { path: 'meeting.md', content: '本文にタグ語を含まないノート', tags: ['tagged'] },
    ]);
    const { container, root, input } = await renderPanel(searcher);
    await typeQuery(input, 'tagged');
    const tags = container.querySelectorAll('.search-result-tag');
    expect(tags).toHaveLength(1);
    expect(tags[0]?.textContent).toBe('#tagged');
    root.unmount();
  });

  it('本文一致の結果はタグ表示を描画しない', async () => {
    // 本文にタグ語を含むノートは content 一致になり、.search-result-tag が出ない
    const searcher = createNoteSearcher([
      { path: 'tags.md', content: '本文に #tagged を含むノート', tags: [] },
    ]);
    const { container, root, input } = await renderPanel(searcher);
    await typeQuery(input, 'tagged');
    expect(container.querySelectorAll('.search-result-tag')).toHaveLength(0);
    root.unmount();
  });
});
