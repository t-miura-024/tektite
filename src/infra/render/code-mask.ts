/**
 * コードの一時マスク（数式抽出の前処理）。
 *
 * フェンスドコードとインラインコードスパンをプレースホルダーへ置き換える。
 * 数式抽出（math.ts）がコード内の `$` を数式と誤検出しないための前処理で、
 * 抽出後に unmaskCode で元へ戻す。
 */

/** コードマスク用プレースホルダー（\uE020..\uE021。ユーザー本文と衝突しない私用領域） */
const CODE_MASK_OPEN = '\uE020';
const CODE_MASK_CLOSE = '\uE021';

/** マスク済みコード 1 件 */
export type CodeMaskItem = {
  readonly marker: string;
  readonly code: string;
};

/** フェンスドコードの開始（``` または ~~~） */
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/;

/**
 * フェンスドコードとインラインコードをプレースホルダーで一時マスクする。
 * 数式抽出の前に使う（コード内の `$` を数式と誤検出しないため）。
 */
export function maskCode(source: string): { text: string; items: readonly CodeMaskItem[] } {
  const items: CodeMaskItem[] = [];
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  let fenceLines: string[] | null = null;

  const addMask = (code: string): string => {
    const marker = `${CODE_MASK_OPEN}${items.length}${CODE_MASK_CLOSE}`;
    items.push({ marker, code });
    return marker;
  };

  for (const line of source.split('\n')) {
    if (fence !== null) {
      const currentFence = fence;
      const fenceClose = ((): boolean => {
        let run = 0;
        for (const current of line) {
          if (current !== currentFence.char) {
            break;
          }
          run += 1;
        }
        return run >= currentFence.len && line.slice(run).trim() === '';
      })();
      if (fenceClose) {
        out.push(addMask([...(fenceLines ?? []), line].join('\n')));
        fence = null;
        fenceLines = null;
        continue;
      }
      fenceLines?.push(line);
      continue;
    }
    const fenceOpen = FENCE_OPEN_RE.exec(line);
    if (fenceOpen && fenceOpen[1]) {
      fence = { char: fenceOpen[1][0] ?? '', len: fenceOpen[1].length };
      fenceLines = [line];
      continue;
    }
    const maskedLine = ((): string => {
      let outInline = '';
      for (let i = 0; i < line.length;) {
        const ch = line[i] ?? '';
        if (ch === '\\') {
          outInline += ch + (line[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (ch === '`') {
          let n = 0;
          for (const current of line.slice(i)) {
            if (current !== '`') {
              break;
            }
            n += 1;
          }
          const run = n;
          const close = line.indexOf('`'.repeat(run), i + run);
          if (close === -1) {
            outInline += line.slice(i);
            break;
          }
          outInline += addMask(line.slice(i, close + run));
          i = close + run;
          continue;
        }
        outInline += ch;
        i += 1;
      }
      return outInline;
    })();
    out.push(maskedLine);
  }
  // フェンスが閉じないまま終了（不正な本文）: マスクせず原文のまま
  if (fenceLines !== null) {
    out.push(...fenceLines);
  }
  return { text: out.join('\n'), items };
}

/** コードマスクを元のコードへ戻す */
export function unmaskCode(text: string, items: readonly CodeMaskItem[]): string {
  let out = text;
  for (const item of items) {
    out = out.split(item.marker).join(item.code);
  }
  return out;
}
