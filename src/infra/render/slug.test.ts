import { describe, expect, it } from 'vitest';

import { slugify } from '@/infra/render/slug';

describe('slugify', () => {
  it('小文字化して空白をハイフンにする', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('日本語はそのまま残す', () => {
    expect(slugify('見出し その 1')).toBe('見出し-その-1');
  });

  it('記号の連続は 1 つのハイフンに畳む', () => {
    expect(slugify('a!! b?? c')).toBe('a-b-c');
  });

  it('前後のハイフンを除去する', () => {
    expect(slugify('!!heading!!')).toBe('heading');
  });

  it('空になる場合は section を返す', () => {
    expect(slugify('!!!')).toBe('section');
    expect(slugify('')).toBe('section');
  });

  it('アンダースコアは保持する', () => {
    expect(slugify('snake_case')).toBe('snake_case');
  });
});
