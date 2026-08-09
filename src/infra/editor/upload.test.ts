/**
 * 画像ペースト / ドロップ（M2）のエディタ統合テスト。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';

import { createEditorView, imageEmbedSnippet, imageFilesFrom } from '@/infra/editor/editor';

// jsdom は matchMedia を持たないため、エディタのテーマ判定用にポリフィルする
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockReturnValue({
    matches: false,
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

/** クリップボード / ドラッグデータを模したオブジェクトで paste / drop イベントを組み立てる */
function makeEvent(type: 'paste' | 'drop', files: File[]): Event {
  const event = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, getData: () => '' } });
  Object.defineProperty(event, 'dataTransfer', { value: { files, getData: () => '' } });
  Object.defineProperty(event, 'clientX', { value: 0 });
  Object.defineProperty(event, 'clientY', { value: 0 });
  return event;
}

/** 画像 File を作る（1x1 PNG の内容） */
function pngFile(name: string): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });
}

/** エディタを生成し、CM6 の本文 DOM（cm-content）へイベントを送るためのヘルパー */
function editorIn(container: HTMLElement, options: Parameters<typeof createEditorView>[2]) {
  const handle = createEditorView(container, 'abc', options);
  // CM6 の domEventHandlers は contentDOM（cm-content）に付与される
  const dom = container.querySelector('.cm-content');
  if (dom === null) {
    throw new Error('CM6 の contentDOM が見つかりません');
  }
  return { handle, dom };
}

describe('imageFilesFrom / imageEmbedSnippet（純関数）', () => {
  it('image/* のファイルだけを抽出する', () => {
    const data = {
      files: [pngFile('a.png'), new File(['text'], 'b.txt', { type: 'text/plain' })],
    } as unknown as DataTransfer;
    const files = imageFilesFrom(data);
    expect(files.map((file) => file.name)).toEqual(['a.png']);
  });

  it('null データは空配列を返す', () => {
    expect(imageFilesFrom(null)).toEqual([]);
  });

  it('複数画像は改行区切りの Embed スニペットになる', () => {
    expect(imageEmbedSnippet(['attachments/a.png', 'attachments/b.png'])).toBe(
      '![[attachments/a.png]]\n![[attachments/b.png]]',
    );
  });
});

describe('エディタのペースト / ドロップ（createEditorView）', () => {
  it('画像ペーストでアップロードされ、カーソル位置に ![[パス]] が挿入される', async () => {
    const upload = vi.fn().mockResolvedValue('attachments/20260809-123456-ab12.png');
    const container = document.createElement('div');
    const { handle, dom } = editorIn(container, { onUploadImage: upload });

    dom.dispatchEvent(makeEvent('paste', [pngFile('x.png')]));

    await vi.waitFor(() => {
      expect(upload).toHaveBeenCalledTimes(1);
      expect(handle.getContent()).toBe('![[attachments/20260809-123456-ab12.png]]abc');
    });
    handle.destroy();
  });

  it('画像を含まないペーストは通常動作に委ね、アップロードしない', async () => {
    const upload = vi.fn();
    const container = document.createElement('div');
    const { handle, dom } = editorIn(container, { onUploadImage: upload });

    dom.dispatchEvent(makeEvent('paste', [new File(['text'], 'b.txt', { type: 'text/plain' })]));

    expect(upload).not.toHaveBeenCalled();
    expect(handle.getContent()).toBe('abc');
    handle.destroy();
  });

  it('複数画像のペーストは成功分だけをまとめて挿入する', async () => {
    const upload = vi
      .fn()
      .mockResolvedValueOnce('attachments/ok.png')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('attachments/ok2.png');
    const container = document.createElement('div');
    const { handle, dom } = editorIn(container, { onUploadImage: upload });

    dom.dispatchEvent(makeEvent('paste', [pngFile('a.png'), pngFile('b.png'), pngFile('c.png')]));

    await vi.waitFor(() => {
      expect(handle.getContent()).toBe('![[attachments/ok.png]]\n![[attachments/ok2.png]]abc');
    });
    handle.destroy();
  });

  it('画像ドロップでも同様に挿入される', async () => {
    const upload = vi.fn().mockResolvedValue('attachments/dropped.png');
    const container = document.createElement('div');
    const { handle, dom } = editorIn(container, { onUploadImage: upload });

    dom.dispatchEvent(makeEvent('drop', [pngFile('d.png')]));

    await vi.waitFor(() => {
      expect(handle.getContent()).toBe('![[attachments/dropped.png]]abc');
    });
    handle.destroy();
  });

  it('updateFilePaths は本文を保持したまま記法装飾を差し替える（再生成しない）', () => {
    const container = document.createElement('div');
    const handle = createEditorView(container, '本文です', { filePaths: ['a.md'] });

    handle.updateFilePaths(['a.md', 'attachments/logo.png']);
    // 本文が失われない（エディタ再生成に伴う巻き戻りがない）
    expect(handle.getContent()).toBe('本文です');
    handle.destroy();
  });
});
