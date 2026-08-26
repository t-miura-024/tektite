/**
 * SPA 内リンク。通常の左クリックは History API 遷移に置き換え、
 * 修飾キー付き / 中クリックはブラウザの既定動作（新規タブ等）に任せる。
 */

import type { AnchorHTMLAttributes, JSX } from 'react';

import { navigate } from '@/ui/router';

export type LinkProps = {
  to: string;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>;

export function Link({ to, onClick, children, ...rest }: LinkProps): JSX.Element {
  return (
    <a
      href={to}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        navigate(to);
        onClick?.(event);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
