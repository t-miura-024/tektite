/**
 * ドメイン層（純 TypeScript・フレームワーク非依存）。
 *
 * この層は tektite の核心概念（Vault / Note / WikiLink / Tag など）の
 * 型・値オブジェクト・ドメインロジックだけを置く。
 *
 * 制約:
 * - React / react-dom を import しない
 * - Cloudflare（@cloudflare/* / wrangler）を import しない
 * - ブラウザ API・Node API にも依存しない（純 TS）
 *
 * 上記の制約は .oxlintrc.json の overrides（no-restricted-imports）で機械的に検査される。
 */

export { isVaultCandidate, isValidGitHubName, vaultRefFullName } from './vault';
export type { Vault, VaultCandidateEligibility, VaultRef } from './vault';
export { ancestorDirectoryPaths, buildVaultTree, isExcludedPath } from './tree';
export type {
  TreeDirectory,
  TreeEntry,
  TreeEntryType,
  TreeFile,
  TreeNode,
  VaultTree,
} from './tree';
