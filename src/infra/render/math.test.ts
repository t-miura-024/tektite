import { describe, expect, it } from 'vitest';

import { extractMath, mathPlaceholder, renderMathItems } from '@/infra/render/math';

describe('extractMath', () => {
  it('インライン数式を抽出してプレースホルダーに置き換える', () => {
    const result = extractMath('面積は $a^2$ です');
    expect(result.items).toEqual([{ kind: 'inline', tex: 'a^2' }]);
    expect(result.text).toBe(`面積は ${mathPlaceholder(0)} です`);
  });

  it('同一行のブロック数式を抽出する', () => {
    const result = extractMath('$$E=mc^2$$');
    expect(result.items).toEqual([{ kind: 'block', tex: 'E=mc^2' }]);
    expect(result.text).toBe(mathPlaceholder(0));
  });

  it('複数行のブロック数式を抽出する', () => {
    const result = extractMath('$$\na+b\nc$$\n本文');
    expect(result.items).toEqual([{ kind: 'block', tex: '\na+b\nc' }]);
    expect(result.text).toBe(`${mathPlaceholder(0)}\n本文`);
  });

  it('閉じ $$ が無いブロック数式は原文のまま', () => {
    const result = extractMath('$$ 未完了の数式');
    expect(result.items).toEqual([]);
    expect(result.text).toBe('$$ 未完了の数式');
  });

  it('閉じ $ が無いインライン数式は原文のまま', () => {
    const result = extractMath('価格 $5');
    expect(result.items).toEqual([]);
    expect(result.text).toBe('価格 $5');
  });

  it('通貨（$5）や $ 直後が空白のものは数式にしない', () => {
    const result = extractMath('$5 と $ x$');
    expect(result.items).toEqual([]);
    expect(result.text).toBe('$5 と $ x$');
  });

  it('閉じ $ の直前が空白のものは数式にしない', () => {
    const result = extractMath('$x $ y');
    expect(result.items).toEqual([]);
    expect(result.text).toBe('$x $ y');
  });

  it('フェンスドコード内の $ は数式にしない', () => {
    const result = extractMath('```\n$x$ $$\n```');
    expect(result.items).toEqual([]);
  });

  it('エスケープされた \\$ は数式にしない', () => {
    const result = extractMath('\\$x$');
    expect(result.items).toEqual([]);
    expect(result.text).toBe('\\$x$');
  });
});

describe('renderMathItems', () => {
  it('katex がある場合は KaTeX HTML を返す', () => {
    const katex = {
      renderToString: (tex: string, options?: { displayMode?: boolean; throwOnError?: boolean }) =>
        `<span class="katex">${tex}${options?.displayMode ? ':display' : ''}</span>`,
    };
    expect(renderMathItems([{ kind: 'inline', tex: 'x' }], katex)).toEqual([
      '<span class="katex">x</span>',
    ]);
    expect(renderMathItems([{ kind: 'block', tex: 'x' }], katex)).toEqual([
      '<span class="katex">x:display</span>',
    ]);
  });

  it('katex がない場合はエスケープ済みフォールバックを返す', () => {
    const [html] = renderMathItems([{ kind: 'inline', tex: '<x>' }], null);
    expect(html).toContain('class="math-fallback"');
    expect(html).toContain('&lt;x&gt;');
  });

  it('katex がエラーを投げる場合はフォールバックに落ちる', () => {
    const katex = {
      renderToString: () => {
        throw new Error('parse error');
      },
    };
    const [html] = renderMathItems([{ kind: 'inline', tex: 'x' }], katex);
    expect(html).toContain('class="math-fallback"');
  });
});
