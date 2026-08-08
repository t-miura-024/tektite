import { Effect, Either, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import {
  SessionFetchError,
  SessionGateway,
  getCurrentSession,
  logout,
} from '@/application/session';
import type { Session } from '@/application/session';

function createGatewayStub(session: Session): SessionGateway {
  return {
    getCurrentSession: vi
      .fn<() => Effect.Effect<Session, SessionFetchError>>()
      .mockReturnValue(Effect.succeed(session)),
    logout: vi.fn<() => Effect.Effect<void, SessionFetchError>>().mockReturnValue(Effect.void),
  };
}

function provideStub(gateway: SessionGateway) {
  return Layer.succeed(SessionGateway, gateway);
}

describe('session ユースケース', () => {
  it('getCurrentSession はゲートウェイのセッション状態を返す（認証済み）', async () => {
    const gateway = createGatewayStub({ status: 'authenticated', user: { login: 'octocat' } });
    const result = await Effect.runPromise(Effect.provide(getCurrentSession, provideStub(gateway)));
    expect(result).toEqual({
      status: 'authenticated',
      user: { login: 'octocat' },
    });
    expect(gateway.getCurrentSession).toHaveBeenCalledOnce();
  });

  it('getCurrentSession は未ログインなら anonymous を返す', async () => {
    const gateway = createGatewayStub({ status: 'anonymous' });
    const result = await Effect.runPromise(Effect.provide(getCurrentSession, provideStub(gateway)));
    expect(result).toEqual({ status: 'anonymous' });
  });

  it('ゲートウェイのエラーは SessionFetchError として伝播する', async () => {
    const gateway: SessionGateway = {
      getCurrentSession: vi
        .fn<() => Effect.Effect<Session, SessionFetchError>>()
        .mockReturnValue(Effect.fail(new SessionFetchError('セッション確認に失敗しました。'))),
      logout: vi.fn<() => Effect.Effect<void, SessionFetchError>>(),
    };
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(getCurrentSession, provideStub(gateway))),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(SessionFetchError);
    }
  });

  it('logout はゲートウェイにセッション破棄を委譲する', async () => {
    const gateway = createGatewayStub({ status: 'authenticated', user: { login: 'octocat' } });
    await Effect.runPromise(Effect.provide(logout, provideStub(gateway)));
    expect(gateway.logout).toHaveBeenCalledOnce();
  });
});
