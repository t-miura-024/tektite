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
});
