/**
 * ファイルツリー表示（ディレクトリの開閉・ファイル選択）。
 *
 * - ドメイン層が構築したツリー（src/domain/tree）を描画する
 * - ファイル選択はノートパスの URL（/:owner/:repo/blob/:path）へ SPA 遷移
 * - role="tree" / treeitem でスクリーンリーダーにも構造が伝わるようにする
 * - インデントは CSS 変数 --tree-depth で深さに比例させる
 */

import type { CSSProperties } from 'react';

import type { TreeDirectory, TreeNode } from '@/domain/tree';
import type { VaultRef } from '@/domain/vault';

import { noteRoutePath } from '@/ui/router';
import { Link } from '@/ui/components/Link';

export interface FileTreeProps {
  root: TreeDirectory;
  vaultRef: VaultRef;
  /** 展開中のディレクトリパス集合（ルートは ''） */
  expandedPaths: ReadonlySet<string>;
  /** 選択中のノートパス（未選択は null） */
  selectedPath: string | null;
  onToggleDirectory: (path: string) => void;
}

export function FileTree({
  root,
  vaultRef,
  expandedPaths,
  selectedPath,
  onToggleDirectory,
}: FileTreeProps) {
  if (root.children.length === 0) {
    return <p className="app-placeholder">表示できるファイルがありません。</p>;
  }
  return (
    <ul role="tree" className="file-tree">
      {root.children.map((child) => (
        <FileTreeNode
          key={child.path}
          node={child}
          depth={0}
          vaultRef={vaultRef}
          expandedPaths={expandedPaths}
          selectedPath={selectedPath}
          onToggleDirectory={onToggleDirectory}
        />
      ))}
    </ul>
  );
}

interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  vaultRef: VaultRef;
  expandedPaths: ReadonlySet<string>;
  selectedPath: string | null;
  onToggleDirectory: (path: string) => void;
}

function FileTreeNode({
  node,
  depth,
  vaultRef,
  expandedPaths,
  selectedPath,
  onToggleDirectory,
}: FileTreeNodeProps) {
  const indent = { '--tree-depth': depth } as CSSProperties;

  if (node.type === 'file') {
    const selected = node.path === selectedPath;
    return (
      <li role="treeitem" aria-selected={selected} className="file-tree-item">
        <Link
          to={noteRoutePath(vaultRef, node.path)}
          className={selected ? 'file-tree-link is-selected' : 'file-tree-link'}
          aria-current={selected ? 'location' : undefined}
          style={indent}
        >
          {node.name}
        </Link>
      </li>
    );
  }

  const isOpen = expandedPaths.has(node.path);
  return (
    <li role="treeitem" aria-expanded={isOpen} className="file-tree-item">
      <button
        type="button"
        className="file-tree-toggle"
        onClick={() => onToggleDirectory(node.path)}
        style={indent}
      >
        <span className="file-tree-caret" aria-hidden="true">
          {isOpen ? '▾' : '▸'}
        </span>
        <span className="file-tree-name">{node.name}</span>
      </button>
      {isOpen && (
        <ul role="group" className="file-tree-group">
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              vaultRef={vaultRef}
              expandedPaths={expandedPaths}
              selectedPath={selectedPath}
              onToggleDirectory={onToggleDirectory}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
