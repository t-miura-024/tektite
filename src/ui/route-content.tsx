/**
 * ログイン済みのときのルート → 画面コンテンツの対応。
 * switch の代わりに early return の if 連鎖で解決する（no-restricted-syntax）。
 */

import type { JSX } from 'react';

import { NotFoundScreen } from '@/ui/screens/not-found-screen';
import { VaultPickerScreen, type VaultPickerScreenProps } from '@/ui/screens/vault-picker-screen';
import { VaultScreen } from '@/ui/screens/vault-screen';
import type { Route } from '@/ui/router';

type ScreenCallbacks = Pick<VaultPickerScreenProps, 'notify' | 'onSessionExpired'>;

export function routeContent(route: Route, callbacks: ScreenCallbacks): JSX.Element {
  if (route.kind === 'vaults') {
    return (
      <VaultPickerScreen notify={callbacks.notify} onSessionExpired={callbacks.onSessionExpired} />
    );
  }
  if (route.kind === 'tree' || route.kind === 'note') {
    return (
      <VaultScreen
        vaultRef={route.ref}
        notePath={route.kind === 'note' ? route.notePath : null}
        notify={callbacks.notify}
        onSessionExpired={callbacks.onSessionExpired}
      />
    );
  }
  return <NotFoundScreen />;
}
