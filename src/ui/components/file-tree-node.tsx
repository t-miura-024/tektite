/**
 * ファイルツリーのノード 1 件（ファイル / ディレクトリ）。
 * role="treeitem" でスクリーンリーダーにも構造が伝わるようにする。
 * 右クリックは親から渡される onOpenMenu へそのまま委譲する。
 */

import type { CSSProperties, JSX, MouseEvent } from 'react';

import type { TreeDirectory, TreeNode } from '@/domain/tree';
import type { VaultRef } from '@/domain/vault';

import { CreateDirectoryEditor, InlineRenameInput } from '@/ui/components/file-tree-editors';
import { Link } from '@/ui/components/link';
import { noteRoutePath } from '@/ui/router';

export type FileTreeNodeProps = {
  node: TreeNode;
  depth: number;
  vaultRef: VaultRef;
  expandedPaths: ReadonlySet<string>;
  selectedPath: string | null;
  /** リネーム入力で置き換える対象パス（null は非表示） */
  renamingPath: string | null;
  /** 新規フォルダー作成フォームを表示するディレクトリパス（null は非表示） */
  creatingDirectory: string | null;
  onToggleDirectory: (path: string) => void;
  onOpenMenu: (target: { path: string; type: 'file' | 'directory' }, x: number, y: number) => void;
  onCreateDirectory: (directory: string, name: string) => void;
  onCancelCreate: () => void;
  onRenameSubmit: (newName: string) => void;
  onRenameCancel: () => void;
};

export function FileTreeNode(props: FileTreeNodeProps): JSX.Element {
  const { node, depth } = props;
  const indent: CSSProperties = { '--tree-depth': depth };
  const openMenuAt = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    props.onOpenMenu({ path: node.path, type: node.type }, event.clientX, event.clientY);
  };

  if (node.type === 'file') {
    return (
      <FileLeafItem
        node={node}
        depth={depth}
        indent={indent}
        vaultRef={props.vaultRef}
        selected={node.path === props.selectedPath}
        renaming={props.renamingPath === node.path}
        openMenuAt={openMenuAt}
        onRenameSubmit={props.onRenameSubmit}
        onRenameCancel={props.onRenameCancel}
      />
    );
  }
  return (
    <DirectoryBranchItem
      {...props}
      node={node}
      depth={depth}
      indent={indent}
      isOpen={props.expandedPaths.has(node.path)}
      openMenuAt={openMenuAt}
    />
  );
}

type FileLeafItemProps = {
  node: Extract<TreeNode, { type: 'file' }>;
  depth: number;
  indent: CSSProperties;
  vaultRef: VaultRef;
  selected: boolean;
  renaming: boolean;
  openMenuAt: (event: MouseEvent) => void;
  onRenameSubmit: (newName: string) => void;
  onRenameCancel: () => void;
};

function FileLeafItem(props: FileLeafItemProps): JSX.Element {
  const { node, depth, indent, vaultRef, selected, renaming, openMenuAt } = props;
  if (renaming) {
    return (
      <li role="treeitem" className="file-tree-item">
        <InlineRenameInput
          defaultValue={node.name}
          indent={depth}
          onSubmit={props.onRenameSubmit}
          onCancel={props.onRenameCancel}
        />
      </li>
    );
  }
  return (
    <li role="treeitem" aria-selected={selected} className="file-tree-item">
      <Link
        to={noteRoutePath(vaultRef, node.path)}
        className={selected ? 'file-tree-link is-selected' : 'file-tree-link'}
        aria-current={selected ? 'location' : undefined}
        style={indent}
        onContextMenu={openMenuAt}
      >
        <span className="file-tree-name">{node.name}</span>
      </Link>
    </li>
  );
}

type DirectoryBranchItemProps = FileTreeNodeProps & {
  node: TreeDirectory;
  depth: number;
  indent: CSSProperties;
  isOpen: boolean;
  openMenuAt: (event: MouseEvent) => void;
};

function DirectoryBranchItem(props: DirectoryBranchItemProps): JSX.Element {
  const { node, depth, indent, isOpen, openMenuAt } = props;
  if (props.renamingPath === node.path) {
    return (
      <li role="treeitem" aria-expanded={isOpen} className="file-tree-item">
        <InlineRenameInput
          defaultValue={node.name}
          indent={depth}
          onSubmit={props.onRenameSubmit}
          onCancel={props.onRenameCancel}
        />
      </li>
    );
  }
  return (
    <li role="treeitem" aria-expanded={isOpen} className="file-tree-item">
      <button
        type="button"
        className="file-tree-toggle"
        onClick={() => props.onToggleDirectory(node.path)}
        style={indent}
        onContextMenu={openMenuAt}
      >
        <span className="file-tree-caret" aria-hidden="true">
          {isOpen ? '⌄' : '›'}
        </span>
        <span className="file-tree-name">{node.name}</span>
      </button>
      {isOpen && (
        <ul role="group" className="file-tree-group">
          {props.creatingDirectory === node.path && (
            <li role="treeitem" className="file-tree-item">
              <CreateDirectoryEditor
                onSubmit={(name) => props.onCreateDirectory(node.path, name)}
                onCancel={props.onCancelCreate}
              />
            </li>
          )}
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              vaultRef={props.vaultRef}
              expandedPaths={props.expandedPaths}
              selectedPath={props.selectedPath}
              renamingPath={props.renamingPath}
              creatingDirectory={props.creatingDirectory}
              onToggleDirectory={props.onToggleDirectory}
              onOpenMenu={props.onOpenMenu}
              onCreateDirectory={props.onCreateDirectory}
              onCancelCreate={props.onCancelCreate}
              onRenameSubmit={props.onRenameSubmit}
              onRenameCancel={props.onRenameCancel}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
