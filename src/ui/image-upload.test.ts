/**
 * 画像アップロードのブラウザ側ユーティリティ（src/ui/image-upload.ts）のテスト。
 * File → base64 変換と、クリップボード由来のファイル名正規化を検証する。
 */

import { describe, expect, it } from 'vitest';

import { fileExtension, fileToBase64, imageFileName } from '@/ui/image-upload';

describe('fileToBase64', () => {
  it('File のバイナリを標準 base64 に変換する', async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png', {
      type: 'image/png',
    });
    expect(await fileToBase64(file)).toBe(btoa('\x89PNG'));
  });

  it('テキスト内容も正しく変換する', async () => {
    const file = new File(['tektite'], 'note.txt', { type: 'text/plain' });
    expect(await fileToBase64(file)).toBe(btoa('tektite'));
  });
});

describe('imageFileName', () => {
  it('拡張子を持つファイル名はそのまま使う', () => {
    const file = new File(['x'], 'screenshot.PNG', { type: 'image/png' });
    expect(imageFileName(file)).toBe('screenshot.PNG');
  });

  it('名前のない画像（スクリーンショットのペースト）は MIME から拡張子を補う', () => {
    const file = new File(['x'], '', { type: 'image/png' });
    expect(imageFileName(file)).toBe('image.png');
  });

  it('MIME が不明な場合は image.png にフォールバックする', () => {
    const file = new File(['x'], '', { type: '' });
    expect(imageFileName(file)).toBe('image.png');
  });
});

describe('fileExtension', () => {
  it('拡張子を小文字で返す', () => {
    expect(fileExtension('photo.JPEG')).toBe('jpeg');
    expect(fileExtension('a/b/c.png')).toBe('png');
  });

  it('拡張子なし・ドット始まり・空文字は null', () => {
    expect(fileExtension('image')).toBeNull();
    expect(fileExtension('.gitignore')).toBeNull();
    expect(fileExtension('')).toBeNull();
  });
});
