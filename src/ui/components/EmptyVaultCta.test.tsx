/**
 * 空リポジトリ CTA（src/ui/components/EmptyVaultCta.tsx）のテスト。
 *
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmptyVaultCta } from '@/ui/components/EmptyVaultCta';

interface Rendered {
  container: HTMLElement;
  root: Root;
  onCreateNote: ReturnType<typeof vi.fn>;
}

async function renderCta(): Promise<Rendered> {
  const onCreateNote = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<EmptyVaultCta onCreateNote={onCreateNote} />);
  });
  return { container, root, onCreateNote };
}

function findByTestId(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector(`[data-testid="${id}"]`);
  if (element === null) {
    throw new Error(`data-testid="${id}" が見つかりません`);
  }
  return element as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('EmptyVaultCta', () => {
  it('ボタンを押すと onCreateNote が呼ばれる（Obsidian 式: 名前はエディタで決める）', async () => {
    const { container, root, onCreateNote } = await renderCta();

    await act(async () => {
      findByTestId(container, 'empty-vault-cta-submit').click();
    });
    expect(onCreateNote).toHaveBeenCalledTimes(1);
    root.unmount();
  });
});
