/**
 * ファイルツリー表示とファイル操作（作成・リネーム・移動・複製・削除）。
 * ドメイン層のツリーを描画し、選択はノートパスの URL へ SPA 遷移する。
 * 操作の実行は VaultScreen のコールバックが担い、ここでは入力等の状態だけ持つ。
 */

import type { JSX } from 'react';

import type { TreeDirectory } from '@/domain/tree';
import type { VaultRef } from '@/domain/vault';

import { CreateDirectoryEditor } from '@/ui/components/file-tree-editors';
import { FileContextMenu } from '@/ui/components/file-context-menu';
import { FileTreeDialogs } from '@/ui/components/file-tree-dialogs';
import { FileTreeNode } from '@/ui/components/file-tree-node';
import { FileTreeToolbar } from '@/ui/components/file-tree-toolbar';
import { useContextMenu, type ContextMenuState } from '@/ui/components/use-context-menu';
import { useFileTreeForms, type FileTreeForms } from '@/ui/components/use-file-tree-forms';

export type FileTreeProps = {
  root: TreeDirectory;
  vaultRef: VaultRef;
  /** 展開中のディレクトリパス集合（ルートは ''） */
  expandedPaths: ReadonlySet<string>;
  /** 選択中のノートパス（未選択は null） */
  selectedPath: string | null;
  onToggleDirectory: (path: string) => void;
  /** 新規ノート（Obsidian 式: directory 直下にデフォルト名で作成し、エディタで開く） */
  onCreateNote: (directory: string) => void;
  /** 新規フォルダー（directory 直下に name で作成する） */
  onCreateDirectory: (directory: string, name: string) => void;
  /** 複製を作成する（対象パスと種別） */
  onDuplicate: (path: string, type: 'file' | 'directory') => void;
  onOpenSearch?: () => void;
  onOpenQuickSwitcher?: () => void;
  onRevealCurrent?: () => void;
  onToggleAll?: () => void;
  allExpanded?: boolean;
  /** リネーム（newName は 1 セグメントの新しい名前）をコミットする */
  onRename: (path: string, type: 'file' | 'directory', newName: string) => void;
  /** 移動（targetDirectory は '' でルート）をコミットする */
  onMove: (path: string, type: 'file' | 'directory', targetDirectory: string) => void;
  /** 削除（実削除。確認ダイアログはこのコンポーネントが挟む）をコミットする */
  onDelete: (path: string, type: 'file' | 'directory') => void;
};

export function FileTree(props: FileTreeProps): JSX.Element {
  const forms = useFileTreeForms(props);
  const openMenu = useContextMenu({
    onCreateNote: props.onCreateNote,
    onOpenCreateForm: forms.openCreate,
    onDuplicate: props.onDuplicate,
    onRequestRename: (path, type) => forms.beginRename({ path, type }),
    onRequestMove: (path, type) => forms.beginMove({ path, type }),
    onRequestDelete: (path, type) => forms.beginDelete({ path, type }),
  });

  return (
    <>
      <FileTreeToolbar
        onCreateNote={() => props.onCreateNote('')}
        onOpenCreateForm={() => forms.openCreate('')}
        onOpenSearch={props.onOpenSearch}
        onOpenQuickSwitcher={props.onOpenQuickSwitcher}
        onRevealCurrent={props.onRevealCurrent}
        onToggleAll={props.onToggleAll}
        allExpanded={props.allExpanded}
        revealDisabled={props.selectedPath === null}
      />
      {forms.creating === '' && (
        <CreateDirectoryEditor
          onSubmit={(name) => forms.submitCreate('', name)}
          onCancel={forms.cancelCreate}
        />
      )}
      <div
        className="file-tree-region"
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu.openMenu('root', event.clientX, event.clientY);
        }}
      >
        <TreeBody
          root={props.root}
          vaultRef={props.vaultRef}
          menu={openMenu}
          forms={forms}
          treeProps={props}
        />
      </div>
      {openMenu.menu !== null && (
        <FileContextMenu menu={openMenu.menu} onClose={openMenu.closeMenu} />
      )}
      <FileTreeDialogs root={props.root} forms={forms} />
    </>
  );
}

/** ツリー本体（ul role="tree"）と空表示。ノート選択の SPA 遷移は Link が担う */
function TreeBody({
  root,
  vaultRef,
  menu,
  forms,
  treeProps,
}: {
  root: TreeDirectory;
  vaultRef: VaultRef;
  menu: ContextMenuState;
  forms: FileTreeForms;
  treeProps: FileTreeProps;
}): JSX.Element {
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
          expandedPaths={treeProps.expandedPaths}
          selectedPath={treeProps.selectedPath}
          renamingPath={forms.renaming?.path ?? null}
          creatingDirectory={forms.creating}
          onToggleDirectory={treeProps.onToggleDirectory}
          onOpenMenu={menu.openMenu}
          onCreateDirectory={forms.submitCreate}
          onCancelCreate={forms.cancelCreate}
          onRenameSubmit={forms.submitRename}
          onRenameCancel={forms.cancelRename}
        />
      ))}
    </ul>
  );
}
