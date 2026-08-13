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

/** 初期同期（POST /api/vaults/:owner/:repo/sync）の結果 */
export interface VaultSyncResult {
  readonly owner: string;
  readonly name: string;
  /** initialized: 初回同期が実行された / already_synced: 既に同期済み / synced: 差分同期 */
  readonly status: 'initialized' | 'already_synced' | 'synced';
  readonly defaultBranch: string;
  /** 取り込んだノート数（already_synced は 0） */
  readonly notes: number;
  /** 差分同期の完了日時（status: 'synced' のみ） */
  readonly syncedAt?: string;
  /** プルで R2 に反映したノート数（status: 'synced' のみ） */
  readonly pulled?: number;
  /** プッシュで GitHub へ反映したファイル数（status: 'synced' のみ） */
  readonly pushed?: number;
  /** 検出した同期衝突（status: 'synced' のみ。解決は resolveSyncConflict） */
  readonly conflicts?: readonly VaultSyncConflict[];
}

/** 同期衝突 1 件（プル時に GitHub 側の変更と R2 側のローカル保存が重なった Note） */
export interface VaultSyncConflict {
  readonly path: string;
  /** R2 側（ローカル保存）の内容 */
  readonly local: string;
  /** GitHub 側の現在内容（GitHub 側で削除された場合は空文字） */
  readonly remote: string;
  /** GitHub 側の blob sha（GitHub 側で削除された場合は null） */
  readonly remoteSha: string | null;
}

/** 同期状態（GET /api/vaults/:owner/:repo/sync。完了条件 10 の表示用） */
export interface VaultSyncStatus {
  readonly owner: string;
  readonly name: string;
  /** 最終同期時刻（未同期 Vault は null） */
  readonly syncedAt: string | null;
  /** 直近の同期失敗理由（定時同期の失敗記録。null は失敗なし） */
  readonly lastSyncError: string | null;
  /** 直近の同期失敗日時（null は失敗なし） */
  readonly lastFailedAt: string | null;
}

/**
 * ポート: Vault 一覧とファイルツリーの取得（Effect Service）。
 * src/infra/github の VaultGatewayLive（Pages Functions 経由）が実装する。
 */
export interface VaultGateway {
  readonly listVaults: () => Effect.Effect<readonly Vault[], VaultFetchError>;
  readonly fetchTree: (ref: VaultRef) => Effect.Effect<VaultTreeData, VaultFetchError>;
  /** 初期同期（GitHub → R2 の全量取り込み）。R2 同期済みなら即完了する */
  readonly initializeSync: (ref: VaultRef) => Effect.Effect<VaultSyncResult, VaultFetchError>;
  /** 明示同期（差分: ツリー sha 比較のプル + 未反映変更のプッシュ。M5） */
  readonly syncVault: (ref: VaultRef) => Effect.Effect<VaultSyncResult, VaultFetchError>;
  /** 同期状態（最終同期時刻・失敗マーク）の取得（M5） */
  readonly fetchSyncStatus: (ref: VaultRef) => Effect.Effect<VaultSyncStatus, VaultFetchError>;
  /** 同期衝突の解決（overwrite: GitHub 側採用 / adopt: ローカル側採用。M5）。解決後の R2 sha を返す */
  readonly resolveSyncConflict: (
    ref: VaultRef,
    path: string,
    resolution: 'overwrite' | 'adopt',
  ) => Effect.Effect<string, VaultFetchError>;
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

/**
 * Vault の初期同期を実行する（GitHub → R2 の全量取り込み）。
 * R2 に同期済みメタがある場合はサーバーが即座に完了を返すため、
 * Vault を開くたびに呼んでも GitHub API は消費しない（初回のみ消費）。
 */
export const initializeVault = (
  ref: VaultRef,
): Effect.Effect<VaultSyncResult, VaultFetchError, VaultGateway> =>
  Effect.gen(function* () {
    const gateway = yield* VaultGateway;
    return yield* gateway.initializeSync(ref);
  });

/**
 * Vault の明示同期を実行する（M5。完了条件 5）。
 * ツリー sha 比較でプルし、未反映の変更を 1 コミットに束ねてプッシュする。
 * 同期衝突が検出された場合は結果の conflicts に含まれ、UI が
 * resolveSyncConflict で解決する。
 */
export const syncVault = (
  ref: VaultRef,
): Effect.Effect<VaultSyncResult, VaultFetchError, VaultGateway> =>
  Effect.gen(function* () {
    const gateway = yield* VaultGateway;
    return yield* gateway.syncVault(ref);
  });

/** 同期状態（最終同期時刻・失敗マーク）を取得する（M5。完了条件 10） */
export const fetchVaultSyncStatus = (
  ref: VaultRef,
): Effect.Effect<VaultSyncStatus, VaultFetchError, VaultGateway> =>
  Effect.gen(function* () {
    const gateway = yield* VaultGateway;
    return yield* gateway.fetchSyncStatus(ref);
  });

/**
 * 同期衝突を解決する（M5。完了条件 6）。解決後の R2 sha を返す。
 * - overwrite: GitHub 側の内容を採用（R2 を GitHub の現在内容で更新）
 * - adopt: ローカル側の内容を採用（R2 のローカル内容を GitHub へ反映）
 */
export const resolveVaultSyncConflict = (
  ref: VaultRef,
  path: string,
  resolution: 'overwrite' | 'adopt',
): Effect.Effect<string, VaultFetchError, VaultGateway> =>
  Effect.gen(function* () {
    const gateway = yield* VaultGateway;
    return yield* gateway.resolveSyncConflict(ref, path, resolution);
  });
