/**
 * URL ハッシュ（#スラグ）で指定された見出し要素へのスクロール。
 * リロード・SPA 遷移・同一ノート内遷移のすべてで動くよう、html 適用後と
 * URL 変更イベントの両方で試みる。
 */

import { useEffect } from 'react';

import { NAVIGATE_EVENT_NAME } from '@/ui/router';

/** ハッシュ（#スラグ）に対応する id の要素へスクロールする */
export function scrollToHashTarget(): void {
  const hash = window.location.hash;
  if (hash.length <= 1) {
    return;
  }
  const id = decodeURIComponent(hash.slice(1));
  document.getElementById(id)?.scrollIntoView({ block: 'start' });
}

/**
 * 見出しアンカー（#スラグ）へのスクロールを購読する。
 * @param html 適用後の HTML（適用完了後にスクロールを試みるきっかけ）
 */
export function useHashScroll(html: string): void {
  useEffect(() => {
    scrollToHashTarget();
    window.addEventListener('hashchange', scrollToHashTarget);
    window.addEventListener(NAVIGATE_EVENT_NAME, scrollToHashTarget);
    return (): void => {
      window.removeEventListener('hashchange', scrollToHashTarget);
      window.removeEventListener(NAVIGATE_EVENT_NAME, scrollToHashTarget);
    };
  }, [html]);
}
