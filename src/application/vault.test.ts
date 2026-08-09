import { Effect, Either, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { VaultFetchError, VaultGateway, listVaults, openVault } from '@/application/vault';
import type { VaultTreeData } from '@/application/vault';
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
    listVaults: vi
      .fn<() => Effect.Effect<readonly Vault[], VaultFetchError>>()
      .mockReturnValue(Effect.succeed(VAULTS)),
    fetchTree: vi
      .fn<(ref: VaultRef) => Effect.Effect<VaultTreeData, VaultFetchError>>()
      .mockReturnValue(Effect.succeed(treeData)),
  };
}

function provideStub(gateway: VaultGateway) {
  return Layer.succeed(VaultGateway, gateway);
}

describe('vault ユースケース', () => {
  it('listVaults はゲートウェイの一覧を返す', async () => {
    const gateway = createGatewayStub({ defaultBranch: 'main', truncated: false, entries: [] });
    const result = await Effect.runPromise(Effect.provide(listVaults, provideStub(gateway)));
    expect(result).toEqual(VAULTS);
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
    const tree = await Effect.runPromise(Effect.provide(openVault(REF), provideStub(gateway)));
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
        .fn<() => Effect.Effect<readonly Vault[], VaultFetchError>>()
        .mockReturnValue(
          Effect.fail(new VaultFetchError('rate_limited', 'レートリミットに達しました。')),
        ),
      fetchTree: vi.fn<(ref: VaultRef) => Effect.Effect<VaultTreeData, VaultFetchError>>(),
    };
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(listVaults, provideStub(gateway))),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(VaultFetchError);
    }
  });
});
