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

async function renderCta(
  overrides: Partial<Parameters<typeof EmptyVaultCta>[0]> = {},
): Promise<Rendered> {
  const onCreateNote = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<EmptyVaultCta onCreateNote={onCreateNote} {...overrides} />);
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

async function typeValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('EmptyVaultCta', () => {
  it('既定名（index.md）が入力済みで、そのまま確定すると onCreateNote が呼ばれる', async () => {
    const { container, root, onCreateNote } = await renderCta();

    const input = findByTestId(container, 'empty-vault-cta-input') as HTMLInputElement;
    expect(input.value).toBe('index.md');

    await act(async () => {
      findByTestId(container, 'empty-vault-cta-submit').click();
    });
    expect(onCreateNote).toHaveBeenCalledWith('index.md');
    root.unmount();
  });

  it('名前を編集して Enter で確定すると、編集後の名前が渡る', async () => {
    const { container, root, onCreateNote } = await renderCta();

    const input = findByTestId(container, 'empty-vault-cta-input') as HTMLInputElement;
    await typeValue(input, 'はじめに.md');
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });

    expect(onCreateNote).toHaveBeenCalledWith('はじめに.md');
    root.unmount();
  });

  it('.md でない名前は検証エラーになり送信されない', async () => {
    const { container, root, onCreateNote } = await renderCta();

    const input = findByTestId(container, 'empty-vault-cta-input') as HTMLInputElement;
    await typeValue(input, 'memo');
    await act(async () => {
      findByTestId(container, 'empty-vault-cta-submit').click();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('.md');
    expect(onCreateNote).not.toHaveBeenCalled();
    root.unmount();
  });

  it('defaultName を上書きできる', async () => {
    const { container, root } = await renderCta({ defaultName: 'start.md' });

    const input = findByTestId(container, 'empty-vault-cta-input') as HTMLInputElement;
    expect(input.value).toBe('start.md');
    root.unmount();
  });
});
