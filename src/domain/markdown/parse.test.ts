import { describe, expect, it } from 'vitest';

import { parseMarkdownDecorations, type MarkdownDecoration } from '@/domain/markdown/parse';

function parse(text: string): MarkdownDecoration[] {
  return parseMarkdownDecorations(text);
}

describe('Markdown 構文解析（ライブプレビュー装飾の基礎）', () => {
  describe('見出し', () => {
    it('マーカーとテキストを分離した装飾範囲を返す', () => {
      expect(parse('# 見出し')).toEqual([
        { from: 0, to: 1, type: 'heading-marker' },
        { from: 2, to: 5, type: 'heading', level: 1 },
      ]);
    });

    it('レベル 2 と 6 の見出しで level が変わる', () => {
      expect(parse('## サブ')).toEqual([
        { from: 0, to: 2, type: 'heading-marker' },
        { from: 3, to: 5, type: 'heading', level: 2 },
      ]);
      expect(parse('###### 最下位')).toEqual([
        { from: 0, to: 6, type: 'heading-marker' },
        { from: 7, to: 10, type: 'heading', level: 6 },
      ]);
    });

    it('見出し内の強調も装飾される', () => {
      expect(parse('# **太字**見出し')).toEqual([
        { from: 0, to: 1, type: 'heading-marker' },
        { from: 2, to: 11, type: 'heading', level: 1 },
        { from: 4, to: 6, type: 'bold' },
      ]);
    });

    it('# のみ・# の後に空白がない行は装飾しない', () => {
      expect(parse('#')).toEqual([]);
      expect(parse('#見出し')).toEqual([]);
    });
  });

  describe('強調', () => {
    it('太字 **text** を装飾する', () => {
      expect(parse('**太字**')).toEqual([{ from: 2, to: 4, type: 'bold' }]);
    });

    it('斜体 *text* を装飾する', () => {
      expect(parse('*斜体*')).toEqual([{ from: 1, to: 3, type: 'italic' }]);
    });

    it('太字斜体 ***text*** を装飾する', () => {
      expect(parse('***強調***')).toEqual([{ from: 3, to: 5, type: 'bold-italic' }]);
    });

    it('段落内の複数装飾は左から順に返す', () => {
      expect(parse('本文 **太字** と *斜体*')).toEqual([
        { from: 5, to: 7, type: 'bold' },
        { from: 13, to: 15, type: 'italic' },
      ]);
    });

    it('閉じマーカーのない強調は装飾しない', () => {
      expect(parse('**閉じなし')).toEqual([]);
    });

    it('エスケープされたマーカーは装飾しない', () => {
      expect(parse('\\*斜体*')).toEqual([]);
    });

    it('ネストした装飾は内側をスキップする（フラット）', () => {
      expect(parse('**太字 `コード`**')).toEqual([{ from: 2, to: 10, type: 'bold' }]);
    });
  });

  describe('インラインコード', () => {
    it('バッククォートを含む範囲を装飾する', () => {
      expect(parse('`コード`')).toEqual([{ from: 0, to: 5, type: 'inline-code' }]);
    });

    it('複数バッククォートの入れ子にも対応する', () => {
      expect(parse('``code ` inside``')).toEqual([{ from: 0, to: 17, type: 'inline-code' }]);
    });

    it('閉じバッククォートのないコードは装飾しない', () => {
      expect(parse('`閉じなし')).toEqual([]);
    });
  });

  describe('リンク', () => {
    it('テキストと URL を別々に装飾する', () => {
      expect(parse('[テキスト](https://example.com)')).toEqual([
        { from: 1, to: 5, type: 'link-text' },
        { from: 7, to: 26, type: 'link-url' },
      ]);
    });

    it('画像 ![...] は装飾しない', () => {
      expect(parse('![alt](https://example.com/a.png)')).toEqual([]);
    });

    it('閉じ括弧のないリンクは装飾しない', () => {
      expect(parse('[テキスト]')).toEqual([]);
      expect(parse('[テキスト](url 空白)')).toEqual([]);
    });
  });

  describe('フェンスドコード', () => {
    it('フェンス行とブロック内を行装飾する', () => {
      expect(parse('```ts\nconst x = 1;\n```')).toEqual([
        { from: 0, to: 5, type: 'code-fence' },
        { from: 6, to: 18, type: 'code-block' },
        { from: 19, to: 22, type: 'code-fence' },
      ]);
    });

    it('閉じフェンスのないブロックは最後までコード装飾する', () => {
      expect(parse('```\ncode\n')).toEqual([
        { from: 0, to: 3, type: 'code-fence' },
        { from: 4, to: 8, type: 'code-block' },
      ]);
    });

    it('~~~ フェンスも対応する', () => {
      expect(parse('~~~\ntext\n~~~')).toEqual([
        { from: 0, to: 3, type: 'code-fence' },
        { from: 4, to: 8, type: 'code-block' },
        { from: 9, to: 12, type: 'code-fence' },
      ]);
    });

    it('コードブロック内の強調・見出しは装飾しない', () => {
      expect(parse('```\n# 見出し **太字**\n```')).toEqual([
        { from: 0, to: 3, type: 'code-fence' },
        { from: 4, to: 16, type: 'code-block' },
        { from: 17, to: 20, type: 'code-fence' },
      ]);
    });
  });

  describe('リスト', () => {
    it('箇条書きのマーカーを装飾する', () => {
      expect(parse('- 箇条書き')).toEqual([{ from: 0, to: 2, type: 'list-marker' }]);
      expect(parse('* 箇条書き')).toEqual([{ from: 0, to: 2, type: 'list-marker' }]);
      expect(parse('+ 箇条書き')).toEqual([{ from: 0, to: 2, type: 'list-marker' }]);
    });

    it('番号付きリストのマーカーを装飾する', () => {
      expect(parse('1. 番号付き')).toEqual([{ from: 0, to: 3, type: 'list-marker' }]);
      expect(parse('10) 番号付き')).toEqual([{ from: 0, to: 4, type: 'list-marker' }]);
    });

    it('インデント付きリストにも対応する', () => {
      expect(parse('  - 入れ子')).toEqual([{ from: 2, to: 4, type: 'list-marker' }]);
    });

    it('リスト本文の強調も装飾される', () => {
      expect(parse('- **太字**項目')).toEqual([
        { from: 0, to: 2, type: 'list-marker' },
        { from: 4, to: 6, type: 'bold' },
      ]);
    });
  });

  describe('タスクリスト', () => {
    it('未完了チェックボックスを checked: false で装飾する', () => {
      expect(parse('- [ ] 未完了')).toEqual([
        { from: 0, to: 2, type: 'task-marker' },
        { from: 2, to: 5, type: 'task-checkbox', checked: false },
      ]);
    });

    it('完了チェックボックスを checked: true で装飾する', () => {
      expect(parse('- [x] 完了')).toEqual([
        { from: 0, to: 2, type: 'task-marker' },
        { from: 2, to: 5, type: 'task-checkbox', checked: true },
      ]);
      expect(parse('- [X] 完了')).toEqual([
        { from: 0, to: 2, type: 'task-marker' },
        { from: 2, to: 5, type: 'task-checkbox', checked: true },
      ]);
    });
  });

  describe('引用', () => {
    it('マーカーと行全体を装飾する', () => {
      expect(parse('> 引用文')).toEqual([
        { from: 0, to: 1, type: 'quote-marker' },
        { from: 0, to: 5, type: 'quote' },
      ]);
    });

    it('入れ子引用のマーカー全体を装飾する', () => {
      expect(parse('>> 入れ子')).toEqual([
        { from: 0, to: 2, type: 'quote-marker' },
        { from: 0, to: 6, type: 'quote' },
      ]);
    });

    it('引用文内の強調も装飾される', () => {
      expect(parse('> **強調**')).toEqual([
        { from: 0, to: 1, type: 'quote-marker' },
        { from: 0, to: 8, type: 'quote' },
        { from: 4, to: 6, type: 'bold' },
      ]);
    });
  });

  describe('水平線', () => {
    it.each(['---', '***', '___'])('%s を装飾する', (line) => {
      expect(parse(line)).toEqual([{ from: 0, to: line.length, type: 'hr' }]);
    });

    it('4 文字以上の水平線も装飾する', () => {
      expect(parse('----')).toEqual([{ from: 0, to: 4, type: 'hr' }]);
    });
  });

  describe('段落・空行', () => {
    it('空行は装飾しない', () => {
      expect(parse('\n\n')).toEqual([]);
    });

    it('段落はインライン解析のみ行う', () => {
      expect(parse('普通の段落')).toEqual([]);
    });

    it('複数行のオフセットが行ごとに正しく加算される', () => {
      expect(parse('# 見出し\n\n本文 **太字**\n')).toEqual([
        { from: 0, to: 1, type: 'heading-marker' },
        { from: 2, to: 5, type: 'heading', level: 1 },
        { from: 12, to: 14, type: 'bold' },
      ]);
    });

    it('先頭以外の行にあるタスクリストも正しい絶対オフセットになる', () => {
      // 先頭行を挟むことで from が 0 でないケースを検証する（回帰: indexOf に絶対位置を渡していた）
      expect(parse('見出しなしの段落\n\n- [x] 完了タスク\n')).toEqual([
        { from: 10, to: 12, type: 'task-marker' },
        { from: 12, to: 15, type: 'task-checkbox', checked: true },
      ]);
    });

    it('先頭以外の行にあるリスト本文の強調も正しいオフセットになる', () => {
      expect(parse('段落\n\n- **太字**項目\n')).toEqual([
        { from: 4, to: 6, type: 'list-marker' },
        { from: 8, to: 10, type: 'bold' },
      ]);
    });

    it('タスクリストの本文にある強調も正しいオフセットになる', () => {
      expect(parse('段落\n\n- [ ] **太字**タスク\n')).toEqual([
        { from: 4, to: 6, type: 'task-marker' },
        { from: 6, to: 9, type: 'task-checkbox', checked: false },
        { from: 12, to: 14, type: 'bold' },
      ]);
    });

    it('すべての装飾オフセットが負にならない（RangeSetBuilder の前提）', () => {
      const content =
        '# 装飾サンプル\n\n**太字テキスト** と *斜体テキスト* と `コード`\n\n- 箇条書き\n1. 番号付きリスト\n\n> 引用文\n\n- [ ] 未完了タスク\n- [x] 完了タスク\n';
      for (const d of parse(content)) {
        expect(d.from).toBeGreaterThanOrEqual(0);
        expect(d.to).toBeGreaterThan(d.from);
      }
    });
  });
});
