import { describe, expect, it, vi } from 'vitest';

import type { VaultTreeData } from './vault';
import { VaultFetchError, VaultUseCases } from './vault';
import type { VaultGateway } from './vault';
import type { Vault, VaultRef } from '@/domain/vault';

const REF: VaultRef = { owner: 'octocat', name: 'notes' };

const VAULTS: readonly Vault[] = [
  {
    owner: 'octocat',
    name: 'notes',
    fullName: 'octocat/notes',
    description: 'Daily notes',
    isPrivate: false,
    defaultBranch: 'main',
    updatedAt: '2026-08-07T12:00:00Z',
  },
];

function createGatewayStub(treeData: VaultTreeData): VaultGateway {
  return {
    listVaults: vi.fn<() => Promise<readonly Vault[]>>().mockResolvedValue(VAULTS),
    fetchTree: vi.fn<(ref: VaultRef) => Promise<VaultTreeData>>().mockResolvedValue(treeData),
  };
}

describe('VaultUseCases', () => {
  it('listVaults はゲートウェイの一覧を返す', async () => {
    const gateway = createGatewayStub({ defaultBranch: 'main', truncated: false, entries: [] });
    const useCases = new VaultUseCases(gateway);
    await expect(useCases.listVaults()).resolves.toEqual(VAULTS);
    expect(gateway.listVaults).toHaveBeenCalledOnce();
  });

  it('openVault はエントリからツリーを構築して返す', async () => {
    const gateway = createGatewayStub({
      defaultBranch: 'main',
      truncated: false,
      entries: [
        { path: 'daily', type: 'directory' },
        { path: 'daily/2026-08-08.md', type: 'file' },
        { path: '.obsidian/app.json', type: 'file' },
      ],
    });
    const useCases = new VaultUseCases(gateway);
    const tree = await useCases.openVault(REF);
    expect(gateway.fetchTree).toHaveBeenCalledWith(REF);
    expect(tree.ref).toEqual(REF);
    expect(tree.defaultBranch).toBe('main');
    expect(tree.truncated).toBe(false);
    // 隠れディレクトリ配下が除外されていること
    expect(tree.root.children.map((child) => child.name)).toEqual(['daily']);
  });

  it('ゲートウェイのエラーは VaultFetchError として伝播する', async () => {
    const gateway: VaultGateway = {
      listVaults: vi
        .fn<() => Promise<readonly Vault[]>>()
        .mockRejectedValue(new VaultFetchError('rate_limited', 'レートリミットに達しました。')),
      fetchTree: vi.fn<(ref: VaultRef) => Promise<VaultTreeData>>(),
    };
    const useCases = new VaultUseCases(gateway);
    await expect(useCases.listVaults()).rejects.toThrow(VaultFetchError);
  });
});
