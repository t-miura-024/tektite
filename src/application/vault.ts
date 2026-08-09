/**
 * Vault 系ユースケース（M3: Vault 選択とファイルツリー表示）。
 *
 * Vault 一覧の取得と、選択した Vault のファイルツリー展開を進行させる。
 * GitHub API には直接触れず、ポート（VaultGateway）経由でだけ通信する。
 * 実装は src/infra/github（Pages Functions プロキシ呼び出し）。
 *
 * ポートは Effect Service（Tag）として定義し、具体実装（Layer）は src/infra が、
 * 組成は src/composition が担う（src/application/session.ts と同じ仕組み）。
 */

import { Context, Effect } from 'effect';

import { buildVaultTree } from '@/domain/tree';
import type { TreeEntry, VaultTree } from '@/domain/tree';
import type { Vault, VaultRef } from '@/domain/vault';

/** Vault 関連の取得エラーの種類（UI がメッセージとリトライ導線を選ぶ材料） */
export type VaultFetchErrorKind =
  | 'unauthenticated'
  | 'rate_limited'
  | 'not_found'
  | 'server'
  | 'network';

/** Vault 一覧 / ファイルツリー取得の通信で発生するエラー */
export class VaultFetchError extends Error {
  readonly kind: VaultFetchErrorKind;

  constructor(kind: VaultFetchErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VaultFetchError';
    this.kind = kind;
  }
}

/** ツリー取得の生データ（ゲートウェイがプロキシから受け取る形式） */
export interface VaultTreeData {
  readonly defaultBranch: string;
  readonly truncated: boolean;
  readonly entries: readonly TreeEntry[];
}

/**
 * ポート: Vault 一覧とファイルツリーの取得（Effect Service）。
 * src/infra/github の VaultGatewayLive（Pages Functions 経由）が実装する。
 */
export interface VaultGateway {
  readonly listVaults: () => Effect.Effect<readonly Vault[], VaultFetchError>;
  readonly fetchTree: (ref: VaultRef) => Effect.Effect<VaultTreeData, VaultFetchError>;
}
export const VaultGateway = Context.GenericTag<VaultGateway>('tektite/VaultGateway');

/** ログインユーザーの Vault 候補一覧を取得する */
export const listVaults: Effect.Effect<readonly Vault[], VaultFetchError, VaultGateway> =
  Effect.gen(function* () {
    const gateway = yield* VaultGateway;
    return yield* gateway.listVaults();
  });

/** Vault を開き、デフォルトブランチのファイルツリーを構築する */
export const openVault = (ref: VaultRef): Effect.Effect<VaultTree, VaultFetchError, VaultGateway> =>
  Effect.gen(function* () {
    const gateway = yield* VaultGateway;
    const data = yield* gateway.fetchTree(ref);
    return {
      ref,
      defaultBranch: data.defaultBranch,
      truncated: data.truncated,
      root: buildVaultTree(data.entries),
    };
  });
