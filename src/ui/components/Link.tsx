/**
 * SPA 内リンク。通常の左クリックは History API 遷移に置き換え、
 * 修飾キー付き / 中クリックはブラウザの既定動作（新規タブ等）に任せる。
 */

import type { AnchorHTMLAttributes } from 'react';

import { navigate } from '../router';

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string;
}

export function Link({ to, onClick, children, ...rest }: LinkProps) {
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
