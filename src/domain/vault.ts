/**
 * Vault のドメインモデル。
 *
 * Vault は GitHub リポジトリ 1 個に対応し、ユーザーがログイン後に
 * 一覧から選択して開く単位（CONTEXT.md 参照）。
 *
 * Vault 候補の条件は「write 権限を持ち、アーカイブ済みでない」こと。
 * 読み取り専用リポジトリやアーカイブ済みリポジトリは変更をコミット
 * できないため、候補から除外する。
 */

/** Vault の識別子（GitHub の owner / repository 名の組） */
export interface VaultRef {
  readonly owner: string;
  readonly name: string;
}

/** ユーザーが選択可能な Vault */
export interface Vault extends VaultRef {
  /** "owner/name" 形式の表示名 */
  readonly fullName: string;
  readonly description: string | null;
  readonly isPrivate: boolean;
  /** デフォルトブランチ（MVP はデフォルトブランチのみ対象） */
  readonly defaultBranch: string;
  /** 最終更新日時（ISO 8601 文字列。不明な場合は空文字） */
  readonly updatedAt: string;
}

export function vaultRefFullName(ref: VaultRef): string {
  return `${ref.owner}/${ref.name}`;
}

/** GitHub のアカウント名 / リポジトリ名に使える文字（寛容な検証） */
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** URL パラメータ由来の名前をそのまま GitHub API に渡せるかの検証 */
export function isValidGitHubName(name: string): boolean {
  return name.length > 0 && name.length <= 100 && GITHUB_NAME_PATTERN.test(name);
}

/** Vault 候補の適格判定に必要な属性 */
export interface VaultCandidateEligibility {
  /** write（push）以上の権限があるか */
  readonly hasWritePermission: boolean;
  readonly isArchived: boolean;
}

/**
 * リポジトリが Vault 候補かどうかを判定する。
 * 読み取り専用（push 不可）やアーカイブ済みは書き込みができないため除外。
 */
export function isVaultCandidate(eligibility: VaultCandidateEligibility): boolean {
  return eligibility.hasWritePermission && !eligibility.isArchived;
}
