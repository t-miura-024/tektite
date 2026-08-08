import { describe, expect, it, vi } from 'vitest';

import type { Session, SessionGateway } from './session';
import { SessionFetchError, SessionUseCases } from './session';

function createGatewayStub(session: Session): SessionGateway {
  return {
    getCurrentSession: vi.fn<() => Promise<Session>>().mockResolvedValue(session),
    logout: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

describe('SessionUseCases', () => {
  it('getCurrentSession はゲートウェイのセッション状態を返す（認証済み）', async () => {
    const gateway = createGatewayStub({ status: 'authenticated', user: { login: 'octocat' } });
    const useCases = new SessionUseCases(gateway);
    await expect(useCases.getCurrentSession()).resolves.toEqual({
      status: 'authenticated',
      user: { login: 'octocat' },
    });
    expect(gateway.getCurrentSession).toHaveBeenCalledOnce();
  });

  it('getCurrentSession は未ログインなら anonymous を返す', async () => {
    const gateway = createGatewayStub({ status: 'anonymous' });
    const useCases = new SessionUseCases(gateway);
    await expect(useCases.getCurrentSession()).resolves.toEqual({ status: 'anonymous' });
  });

  it('ゲートウェイのエラーは SessionFetchError として伝播する', async () => {
    const gateway: SessionGateway = {
      getCurrentSession: vi
        .fn<() => Promise<Session>>()
        .mockRejectedValue(new SessionFetchError('セッション確認に失敗しました。')),
      logout: vi.fn<() => Promise<void>>(),
    };
    const useCases = new SessionUseCases(gateway);
    await expect(useCases.getCurrentSession()).rejects.toThrow(SessionFetchError);
  });

  it('logout はゲートウェイにセッション破棄を委譲する', async () => {
    const gateway = createGatewayStub({ status: 'authenticated', user: { login: 'octocat' } });
    const useCases = new SessionUseCases(gateway);
    await useCases.logout();
    expect(gateway.logout).toHaveBeenCalledOnce();
  });
});
