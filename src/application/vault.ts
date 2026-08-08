/**
 * Vault 系ユースケース（M3: Vault 選択とファイルツリー表示）。
 *
 * Vault 一覧の取得と、選択した Vault のファイルツリー展開を進行させる。
 * GitHub API には直接触れず、ポート（VaultGateway）経由でだけ通信する。
 * 実装は src/infra/github（Pages Functions プロキシ呼び出し）。
 */

import type { TreeEntry, VaultTree } from '@/domain/tree';
import { buildVaultTree } from '@/domain/tree';
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
 * ポート: Vault 一覧とファイルツリーの取得。
 * src/infra/github の HttpVaultGateway が Pages Functions 経由で実装する。
 */
export interface VaultGateway {
  listVaults(): Promise<readonly Vault[]>;
  fetchTree(ref: VaultRef): Promise<VaultTreeData>;
}

/**
 * Vault 系ユースケースをまとめる。
 * UI 層はこれを通じてのみ Vault / ツリー状態を操作する。
 */
export class VaultUseCases {
  constructor(private readonly gateway: VaultGateway) {}

  /** ログインユーザーの Vault 候補一覧を取得する */
  listVaults(): Promise<readonly Vault[]> {
    return this.gateway.listVaults();
  }

  /** Vault を開き、デフォルトブランチのファイルツリーを構築する */
  async openVault(ref: VaultRef): Promise<VaultTree> {
    const data = await this.gateway.fetchTree(ref);
    return {
      ref,
      defaultBranch: data.defaultBranch,
      truncated: data.truncated,
      root: buildVaultTree(data.entries),
    };
  }
}
