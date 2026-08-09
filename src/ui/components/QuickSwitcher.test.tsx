/**
 * クイックスイッチャーの UI ロジックテスト（M4: M3）。
 *
 * 既存のテスト環境は node のため、このファイルはファイル先頭の
 * @vitest-environment ディレクティブで jsdom に切り替えて検証する
 * （SearchPanel.test.tsx と同じ方式）。検索・選択・キー操作・遷移をカバーする。
 *
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { VaultRef } from '@/domain/vault';

import { QuickSwitcher } from '@/ui/components/QuickSwitcher';

const vaultRef: VaultRef = { owner: 'owner', name: 'repo' };
const NOTE_PATHS = ['projects/tektite.md', 'daily/2026-08-07.md', 'render.md'];

interface Rendered {
  container: HTMLElement;
  root: Root;
  input: HTMLInputElement;
}

async function renderSwitcher(
  notePaths: readonly string[] | null,
  onClose?: () => void,
  indexFailed = false,
  onRetry?: () => void,
): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QuickSwitcher
        vaultRef={vaultRef}
        notePaths={notePaths}
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
  return [...container.querySelectorAll<HTMLElement>('[data-testid="quick-switch-result"]')];
}

function selected(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="quick-switch-result"][aria-selected="true"]');
}

afterEach(() => {
  // テスト間でパスを共有しない（navigate の履歴をリセット）
  window.history.replaceState(null, '', '/');
});

describe('QuickSwitcher', () => {
  it('空クエリでは全ノートが表示される', async () => {
    const { container, root, input } = await renderSwitcher(NOTE_PATHS);
    const items = results(container);
    expect(items).toHaveLength(3);
    // 表示名（拡張子なし）がそのまま列挙される
    const names = [...container.querySelectorAll('.quick-switch-result-name')].map(
      (name) => name.textContent,
    );
    expect(names).toEqual(['render', 'tektite', '2026-08-07']);
    expect(input.value).toBe('');
    root.unmount();
  });

  it('ファジー検索（部分列一致）でノートを絞り込める', async () => {
    const { container, root, input } = await renderSwitcher(NOTE_PATHS);
    await typeQuery(input, 'tkt');
    const items = results(container);
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('tektite');
    // 一致位置が <mark> で装飾される（t@0, k@2, t@3）
    const marks = container.querySelectorAll('.quick-switch-result-name mark');
    expect([...marks].map((mark) => mark.textContent)).toEqual(['t', 'k', 't']);
    root.unmount();
  });

  it('一致がない場合はメッセージを表示する', async () => {
    const { container, root, input } = await renderSwitcher(NOTE_PATHS);
    await typeQuery(input, 'zzzz');
    expect(results(container)).toHaveLength(0);
    expect(container.textContent).toContain('一致するノートはありません');
    root.unmount();
  });

  it('索引未ロード（notePaths null）の場合は読み込み中を表示する', async () => {
    const { container, root } = await renderSwitcher(null);
    expect(container.textContent).toContain('ノート索引を読み込み中…');
    root.unmount();
  });

  it('索引の読み込みに失敗した場合はエラーと再試行ボタンを表示する', async () => {
    let retried = false;
    const { container, root } = await renderSwitcher(
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
    const { container, root, input } = await renderSwitcher(NOTE_PATHS);
    await typeQuery(input, '2026');
    const items = results(container);
    expect(items.length).toBe(1);
    // 対象を増やして選択移動を検証する
    const {
      root: root2,
      input: input2,
      container: container2,
    } = await renderSwitcher(['daily/2026-08-07.md', 'daily/2026-08-08.md']);
    await typeQuery(input2, '2026');
    const candidates = results(container2);
    expect(candidates.length).toBe(2);
    expect(selected(container2)?.textContent).toBe(candidates[0]?.textContent);
    await pressKey(input2, 'ArrowDown');
    expect(selected(container2)?.textContent).toBe(candidates[1]?.textContent);
    await pressKey(input2, 'ArrowUp');
    expect(selected(container2)?.textContent).toBe(candidates[0]?.textContent);
    root.unmount();
    root2.unmount();
  });

  it('Enter で選択中のノートを開きパレットを閉じる', async () => {
    let closed = false;
    const { root, input } = await renderSwitcher(NOTE_PATHS, () => {
      closed = true;
    });
    await typeQuery(input, 'tektite');
    await pressKey(input, 'Enter');
    expect(window.location.pathname).toBe('/owner/repo/blob/projects/tektite.md');
    expect(closed).toBe(true);
    root.unmount();
  });

  it('IME 変換中の Enter（isComposing）はノートを開かない', async () => {
    let closed = false;
    const { root, input } = await renderSwitcher(NOTE_PATHS, () => {
      closed = true;
    });
    await typeQuery(input, 'tektite');
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
    let closed = false;
    const { root, input } = await renderSwitcher(NOTE_PATHS, () => {
      closed = true;
    });
    await typeQuery(input, 'tektite');
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
    const { container, root, input } = await renderSwitcher(NOTE_PATHS);
    await typeQuery(input, 'render');
    const item = results(container)[0];
    expect(item).toBeDefined();
    await act(async () => {
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(window.location.pathname).toBe('/owner/repo/blob/render.md');
    root.unmount();
  });

  it('Esc でパレットを閉じる', async () => {
    let closed = false;
    const { root, input } = await renderSwitcher(NOTE_PATHS, () => {
      closed = true;
    });
    await pressKey(input, 'Escape');
    expect(closed).toBe(true);
    root.unmount();
  });

  it('Tab キーでフォーカスがパレット内に留まる', async () => {
    const { container, root, input } = await renderSwitcher(NOTE_PATHS);
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
    const { container, root, input } = await renderSwitcher(
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
});
