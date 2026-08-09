/**
 * SPA ルーティング（History API ベース、ルーターライブラリ不使用）。
 *
 * URL 構造（パスベースディープリンク。リロードで状態を復元する）:
 * - `/`                        … Vault 選択画面
 * - `/:owner/:repo`            … Vault 内ファイルツリー
 * - `/:owner/:repo/blob/:path` … ノートパス（表示は次計画。ここではルーティング構造のみ）
 * - その他                     … 404 画面（アプリ内のルート解決ができない場合）
 *
 * SPA フォールバック: Cloudflare Pages はアセットにマッチしないパスに対して
 * index.html を 200 で返す（プラットフォーム標準の挙動）。そのため
 * _redirects や catch-all Function は不要で、ディープリンクをリロードしても
 * このルーターが URL から状態を復元できる。
 * （`/* /index.html 200` のような _redirects ルールは、Pages の html 正規化と
 * 組み合わさって無限ループになるため Pages 側で無視される。使ってはならない。）
 */

import { useEffect, useState } from 'react';

import { err, ok } from '@/domain/result';
import type { Result } from '@/domain/result';
import { isValidGitHubName } from '@/domain/vault';
import type { VaultRef } from '@/domain/vault';

export type Route =
  | { kind: 'vaults' }
  | { kind: 'tree'; ref: VaultRef }
  | { kind: 'note'; ref: VaultRef; notePath: string }
  | { kind: 'not-found' };

/** navigate() を通知するカスタムイベント名（popstate は SPA 内遷移では発火しないため） */
export const NAVIGATE_EVENT_NAME = 'tektite:navigate';

/** パスセグメントの URL デコード（不正なパーセントエスケープは Err） */
function decodeSegment(segment: string): Result<string, 'invalid_percent_escape'> {
  try {
    return ok(decodeURIComponent(segment));
  } catch {
    return err('invalid_percent_escape');
  }
}

function parseVaultRef(ownerSegment: string, nameSegment: string): VaultRef | null {
  const owner = decodeSegment(ownerSegment);
  const name = decodeSegment(nameSegment);
  if (!owner.ok || !name.ok || !isValidGitHubName(owner.value) || !isValidGitHubName(name.value)) {
    return null;
  }
  return { owner: owner.value, name: name.value };
}

/** パス名を Route に解決する（純関数。window に依存しない） */
export function parseRoute(pathname: string): Route {
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return { kind: 'vaults' };
  }
  const [first, second, third, ...rest] = segments;
  if (segments.length === 2 && first !== undefined && second !== undefined) {
    const ref = parseVaultRef(first, second);
    return ref ? { kind: 'tree', ref } : { kind: 'not-found' };
  }
  if (segments.length >= 4 && first !== undefined && second !== undefined && third === 'blob') {
    const ref = parseVaultRef(first, second);
    if (!ref) {
      return { kind: 'not-found' };
    }
    const pathParts: string[] = [];
    for (const segment of rest) {
      const decoded = decodeSegment(segment);
      if (!decoded.ok || decoded.value.length === 0) {
        return { kind: 'not-found' };
      }
      pathParts.push(decoded.value);
    }
    return { kind: 'note', ref, notePath: pathParts.join('/') };
  }
  return { kind: 'not-found' };
}

/** Vault ツリー画面の URL を作る */
export function vaultRoutePath(ref: VaultRef): string {
  return `/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
}

/** ノートパスの URL を作る（パスの / はセグメント区切りとして保持し、各セグメントをエンコード） */
export function noteRoutePath(ref: VaultRef, notePath: string): string {
  const encodedPath = notePath.split('/').map(encodeURIComponent).join('/');
  return `${vaultRoutePath(ref)}/blob/${encodedPath}`;
}

/**
 * SPA 内遷移（pushState + 通知）。同じパスなら何もしない。
 * パスは同じでハッシュ（見出しアンカー）だけ変わる遷移は pushState する
 * （`[[ノート#見出し]]` で同一ノート内の見出しへ移動するため）。
 */
export function navigate(to: string): void {
  const current = `${window.location.pathname}${window.location.hash}`;
  if (current === to) {
    return;
  }
  window.history.pushState(null, '', to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT_NAME));
}

/** 現在の Route を購読する（ブラウザバック / SPA 内遷移に追従） */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', sync);
    window.addEventListener(NAVIGATE_EVENT_NAME, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAVIGATE_EVENT_NAME, sync);
    };
  }, []);
  return route;
}
