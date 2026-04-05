import { IdempotencyConfig, IdempotencyModule } from '../../modules/idempotency/idempotency'
import { IdempotencyStore, IdempotencyRecord } from '../../modules/idempotency/stores/store'
import { RequestContext } from '../../core/context'
import { createHash } from 'crypto'
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    method: 'POST',
    path: '/orders',
    headers: { 'idempotency-key': 'test-key-123' },
    body: {},
    ...overrides,
  }
}

function makeNext(fn?: () => void) {
  return jest.fn(async () => fn?.())
}

const noopHandler = async () => {}

/**
 * Creates a fully-featured mock store.
 * Tests delete specific methods to simulate stores without acquire/release.
 */
function makeStore(overrides: Partial<IdempotencyStore> = {}): jest.Mocked<IdempotencyStore> {
  return {
    acquire: jest.fn<(key: string, ttl?: number) => Promise<boolean>>().mockResolvedValue(true),
    get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(null),
    set: jest
      .fn<(key: string, value: IdempotencyRecord, ttlSeconds?: number) => Promise<void>>()
      .mockResolvedValue(undefined),
    release: jest.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined),
    delete: jest.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  } as jest.Mocked<IdempotencyStore>
}

function makeModule(
  storeOverrides: Partial<IdempotencyStore> = {},
  configOverrides: Partial<IdempotencyConfig> = {},
) {
  const store = makeStore(storeOverrides)
  const module = new IdempotencyModule({ store, ...configOverrides })
  return { module, store }
}

// ─── Constructor validation ───────────────────────────────────────────────────

describe('constructor — validation', () => {
  it('throws in strict mode when store has no acquire()', () => {
    const store = makeStore()
    delete (store as any).acquire
    expect(() => new IdempotencyModule({ store, onStoreFailure: 'strict' })).toThrow('acquire()')
  })

  it('error message explains how to implement acquire() for different backends', () => {
    const store = makeStore()
    delete (store as any).acquire
    expect(() => new IdempotencyModule({ store, onStoreFailure: 'strict' })).toThrow('SET NX EX')
  })

  it('does not throw in bypass mode when store has no acquire()', () => {
    const store = makeStore()
    delete (store as any).acquire
    expect(() => new IdempotencyModule({ store, onStoreFailure: 'bypass' })).not.toThrow()
  })

  it('does not throw when store implements acquire()', () => {
    const store = makeStore()
    expect(() => new IdempotencyModule({ store })).not.toThrow()
  })

  it('applies correct defaults', async () => {
    const { module, store } = makeModule()
    const ctx = makeCtx()
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.acquire).toHaveBeenCalledWith(expect.any(String), 30) // processingTtl
    expect(store.set).toHaveBeenCalledWith(expect.any(String), expect.any(Object), 3600) // ttl
  })
})

// ─── Key extraction ───────────────────────────────────────────────────────────

describe('idempotency key extraction', () => {
  it('passes through with no idempotency key', async () => {
    const { module, store } = makeModule()
    const ctx = makeCtx({ headers: {} })
    const next = makeNext()
    await module.execute(ctx, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(store.acquire).not.toHaveBeenCalled()
  })

  it('skips idempotency when key header is empty string', async () => {
    const { module, store } = makeModule()
    const ctx = makeCtx({ headers: { 'idempotency-key': '' } })
    const next = makeNext()
    await module.execute(ctx, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(store.acquire).not.toHaveBeenCalled()
  })

  it('matches header name case-insensitively', async () => {
    const { module, store } = makeModule({}, { key: 'Idempotency-Key' })
    const ctx = makeCtx({ headers: { 'IDEMPOTENCY-KEY': 'upper-key' } })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.acquire).toHaveBeenCalledWith('upper-key', expect.any(Number))
  })

  it('takes first element when header is an array', async () => {
    const { module, store } = makeModule()
    const ctx = makeCtx({ headers: { 'idempotency-key': ['key-one', 'key-two'] as any } })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.acquire).toHaveBeenCalledWith('key-one', expect.any(Number))
  })

  it('scopes store keys by method and normalized path', async () => {
    const { module, store } = makeModule()
    const ctx = makeCtx({
      path: '/orders/?b=2&a=1',
      headers: { 'idempotency-key': 'exact-key' },
    })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    const scopedKey = 'exact-key'
    expect(store.acquire).toHaveBeenCalledWith(scopedKey, expect.any(Number))
    expect(store.set).toHaveBeenCalledWith(scopedKey, expect.any(Object), expect.any(Number))
  })

  it('rejects idempotency keys longer than 255 characters with 422', async () => {
    const { module, store } = makeModule()
    const ctx = makeCtx({ headers: { 'idempotency-key': 'k'.repeat(256) } })
    const next = makeNext()

    await module.execute(ctx, next)

    expect(ctx.statusCode).toBe(422)
    expect(ctx.response).toMatchObject({ error: 'invalid_idempotency_key' })
    expect(next).not.toHaveBeenCalled()
    expect(store.acquire).not.toHaveBeenCalled()
  })

  it('falls back to the root path when ctx.path is empty', async () => {
    const { module, store } = makeModule()
    const ctx = makeCtx({
      path: '',
      headers: { 'idempotency-key': 'root-key' },
    })

    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )

    expect(store.acquire).toHaveBeenCalledWith('root-key', expect.any(Number))
  })
})

// ─── Locked path: acquire() returns true ─────────────────────────────────────

describe('locked path — acquire() returns true (happy path)', () => {
  it('calls next() exactly once', async () => {
    const { module } = makeModule()
    const next = makeNext(() => {})
    await module.execute(makeCtx(), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('calls acquire() exactly once', async () => {
    const { module, store } = makeModule()
    await module.execute(
      makeCtx(),
      makeNext(() => {}),
    )
    expect(store.acquire).toHaveBeenCalledTimes(1)
  })

  it('forwards processingTtl to acquire()', async () => {
    const { module, store } = makeModule({}, { processingTtl: 120 })
    await module.execute(makeCtx(), noopHandler)
    expect(store.acquire).toHaveBeenCalledWith(expect.any(String), 120)
  })

  it('does not call get() on happy path', async () => {
    const { module, store } = makeModule()
    await module.execute(
      makeCtx(),
      makeNext(() => {}),
    )
    expect(store.get).not.toHaveBeenCalled()
  })

  it('does not call release() on happy path', async () => {
    const { module, store } = makeModule()
    await module.execute(
      makeCtx(),
      makeNext(() => {}),
    )
    expect(store.release).not.toHaveBeenCalled()
  })

  it('does not call delete() on happy path', async () => {
    const { module, store } = makeModule()
    await module.execute(
      makeCtx(),
      makeNext(() => {}),
    )
    expect(store.delete).not.toHaveBeenCalled()
  })

  it('stores completed response with correct shape', async () => {
    const { module, store } = makeModule()
    const ctx = makeCtx()
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = { id: 'order_1' }
        ctx.statusCode = 201
      }),
    )
    expect(store.set).toHaveBeenCalledWith(
      'test-key-123',
      { status: 'completed', response: { id: 'order_1' }, statusCode: 201, fingerprint: 'POST' },
      expect.any(Number),
    )
  })

  it('defaults statusCode to 200 in stored record when not set', async () => {
    const { module, store } = makeModule()
    const ctx = makeCtx()
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = { ok: true }
      }),
    )
    expect(store.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ statusCode: 200 }),
      expect.any(Number),
    )
  })

  it('calls set() after next() — not before', async () => {
    const callOrder: string[] = []
    const store = makeStore({
      set: jest
        .fn<(key: string, value: IdempotencyRecord, ttlSeconds?: number) => Promise<void>>()
        .mockImplementation(async () => {
          callOrder.push('set')
        }),
    })
    const module = new IdempotencyModule({ store })
    const ctx = makeCtx()
    await module.execute(
      ctx,
      jest.fn(async () => {
        callOrder.push('next')
      }),
    )
    expect(callOrder).toEqual(['next', 'set'])
  })

  it('passes configured ttl to set()', async () => {
    const { module, store } = makeModule({}, { ttl: 7200 })
    const ctx = makeCtx()
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.set).toHaveBeenCalledWith(expect.any(String), expect.any(Object), 7200)
  })
})

// ─── Locked path: acquire() returns false ────────────────────────────────────

describe('method gating', () => {
  it('skips idempotency for GET requests even when a key is present', async () => {
    const { module, store } = makeModule()
    const ctx = makeCtx({ method: 'GET' })
    const next = makeNext(() => {
      ctx.response = { ok: true }
      ctx.statusCode = 200
    })

    await module.execute(ctx, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(store.acquire).not.toHaveBeenCalled()
    expect(store.set).not.toHaveBeenCalled()
  })
})

// ─── Locked path: acquire() returns false ────────────────────────────────────

describe('locked path — acquire() returns false (duplicate)', () => {
  it('returns 409 with Retry-After when record is processing', async () => {
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(null),
      },
      { processingTtl: 30 },
    )
    const ctx = makeCtx()
    await module.execute(ctx, noopHandler)
    expect(ctx.statusCode).toBe(409)
    expect(ctx.response).toMatchObject({
      error: 'idempotency_key_in_use',
      message: 'A request with this key is already in progress',
      retryAfter: 30,
    })
    expect(ctx.responseHeaders?.['Retry-After']).toBe('30')
  })

  it('Retry-After header matches processingTtl', async () => {
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(null),
      },
      { processingTtl: 90 },
    )
    const ctx = makeCtx()
    await module.execute(ctx, noopHandler)
    expect(ctx.responseHeaders?.['Retry-After']).toBe('90')
    expect(ctx.response).toMatchObject({
      error: 'idempotency_key_in_use',
      message: 'A request with this key is already in progress',
      retryAfter: 90,
    })
  })

  it('returns cached response when completed and strategy is cache', async () => {
    const record: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
    }
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockResolvedValue(record),
      },
      { duplicateStrategy: 'cache' },
    )
    const ctx = makeCtx()
    await module.execute(ctx, noopHandler)
    expect(ctx.response).toEqual({ id: 'order_1' })
    expect(ctx.statusCode).toBe(201)
    expect(ctx.responseHeaders?.['Idempotency-Replayed']).toBe('true')
  })

  it('defaults statusCode to 200 when cached record has no statusCode', async () => {
    const record: IdempotencyRecord = { status: 'completed', response: { ok: true } }
    const { module } = makeModule({
      acquire: jest.fn<(key: string, ttl?: number) => Promise<boolean>>().mockResolvedValue(false),
      get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(record),
    })
    const ctx = makeCtx()
    await module.execute(ctx, noopHandler)
    expect(ctx.statusCode).toBe(200)
  })

  it('returns 409 when completed and strategy is reject', async () => {
    const record: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
    }
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockResolvedValue(record),
      },
      { duplicateStrategy: 'reject' },
    )
    const ctx = makeCtx()
    await module.execute(ctx, noopHandler)
    expect(ctx.statusCode).toBe(409)
    expect(ctx.response).toMatchObject({ error: 'duplicate_request' })
  })

  it('reject strategy does not expose cached response body', async () => {
    const record: IdempotencyRecord = {
      status: 'completed',
      response: { secret: 'data' },
      statusCode: 201,
    }
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockResolvedValue(record),
      },
      { duplicateStrategy: 'reject' },
    )
    const ctx = makeCtx()
    await module.execute(ctx, noopHandler)
    expect(ctx.response).not.toHaveProperty('secret')
    expect(ctx.responseHeaders?.['Idempotency-Replayed']).toBeUndefined()
  })

  it('cache strategy does not set Retry-After header', async () => {
    const record: IdempotencyRecord = { status: 'completed', response: {}, statusCode: 200 }
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockResolvedValue(record),
      },
      { duplicateStrategy: 'cache' },
    )
    const ctx = makeCtx()
    await module.execute(ctx, noopHandler)
    expect(ctx.responseHeaders?.['Retry-After']).toBeUndefined()
  })

  it('never calls next() on any duplicate path', async () => {
    const { module } = makeModule({
      acquire: jest.fn<(key: string, ttl?: number) => Promise<boolean>>().mockResolvedValue(false),
      get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(null),
    })
    const next = makeNext()
    await module.execute(makeCtx(), next)
    expect(next).not.toHaveBeenCalled()
  })

  it('never calls release() when acquire() returns false', async () => {
    const { module, store } = makeModule({
      acquire: jest.fn<(key: string, ttl?: number) => Promise<boolean>>().mockResolvedValue(false),
      get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(null),
    })
    await module.execute(makeCtx(), noopHandler)
    expect(store.release).not.toHaveBeenCalled()
  })

  it('never calls delete() when acquire() returns false', async () => {
    const { module, store } = makeModule({
      acquire: jest.fn<(key: string, ttl?: number) => Promise<boolean>>().mockResolvedValue(false),
      get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(null),
    })
    await module.execute(makeCtx(), noopHandler)
    expect(store.delete).not.toHaveBeenCalled()
  })

  it('get() is called with the exact idempotency key', async () => {
    const { module, store } = makeModule({
      acquire: jest.fn<(key: string, ttl?: number) => Promise<boolean>>().mockResolvedValue(false),
    })
    const ctx = makeCtx({ headers: { 'idempotency-key': 'my-key' } })
    await module.execute(ctx, noopHandler)
    expect(store.get).toHaveBeenCalledWith('my-key')
    expect(store.get).toHaveBeenCalledTimes(1)
  })
})

// ─── Locked path: handler throws ─────────────────────────────────────────────

describe('locked path — handler throws', () => {
  it('calls release() with correct key', async () => {
    const { module, store } = makeModule()
    await expect(
      module.execute(
        makeCtx(),
        jest.fn<() => Promise<void>>().mockRejectedValue(new Error('boom')),
      ),
    ).rejects.toThrow()
    expect(store.release).toHaveBeenCalledWith('test-key-123')
  })

  it('calls release() exactly once', async () => {
    const { module, store } = makeModule()
    await expect(
      module.execute(
        makeCtx(),
        jest.fn<() => Promise<void>>().mockRejectedValue(new Error('boom')),
      ),
    ).rejects.toThrow()
    expect(store.release).toHaveBeenCalledTimes(1)
  })

  it('rethrows original handler error', async () => {
    const { module } = makeModule()
    await expect(
      module.execute(
        makeCtx(),
        jest.fn<() => Promise<void>>().mockRejectedValue(new Error('handler error')),
      ),
    ).rejects.toThrow('handler error')
  })

  it('does not call set()', async () => {
    const { module, store } = makeModule()
    await expect(
      module.execute(
        makeCtx(),
        jest.fn<() => Promise<void>>().mockRejectedValue(new Error('boom')),
      ),
    ).rejects.toThrow()
    expect(store.set).not.toHaveBeenCalled()
  })

  it('does not call delete()', async () => {
    const { module, store } = makeModule()
    await expect(
      module.execute(
        makeCtx(),
        jest.fn<() => Promise<void>>().mockRejectedValue(new Error('boom')),
      ),
    ).rejects.toThrow()
    expect(store.delete).not.toHaveBeenCalled()
  })

  it('rethrows original error even when release() also throws', async () => {
    const { module } = makeModule({
      release: jest
        .fn<(key: string) => Promise<void>>()
        .mockRejectedValue(new Error('release failed')),
    })
    await expect(
      module.execute(
        makeCtx(),
        jest.fn<() => Promise<void>>().mockRejectedValue(new Error('handler error')),
      ),
    ).rejects.toThrow('handler error')
  })
})

// ─── Locked path: set() fails after handler succeeds ─────────────────────────

describe('locked path — set() throws after next() succeeds', () => {
  it('rethrows in strict mode', async () => {
    const { module } = makeModule(
      {
        set: jest
          .fn<(key: string, value: IdempotencyRecord, ttlSeconds?: number) => Promise<void>>()
          .mockRejectedValue(new Error('set failed')),
      },
      { onStoreFailure: 'strict' },
    )
    const ctx = makeCtx()
    await expect(
      module.execute(
        ctx,
        makeNext(() => {
          ctx.response = {}
        }),
      ),
    ).rejects.toThrow('set failed')
  })

  it('does not rethrow in bypass mode', async () => {
    const { module } = makeModule(
      {
        set: jest
          .fn<(key: string, value: IdempotencyRecord, ttlSeconds?: number) => Promise<void>>()
          .mockRejectedValue(new Error('set failed')),
      },
      { onStoreFailure: 'bypass' },
    )
    const ctx = makeCtx()
    await expect(
      module.execute(
        ctx,
        makeNext(() => {
          ctx.response = {}
        }),
      ),
    ).resolves.not.toThrow()
  })

  it('does NOT call release() — next() already ran', async () => {
    const { module, store } = makeModule(
      {
        set: jest
          .fn<(key: string, value: IdempotencyRecord, ttlSeconds?: number) => Promise<void>>()
          .mockRejectedValue(new Error('set failed')),
      },
      { onStoreFailure: 'bypass' },
    )
    const ctx = makeCtx()
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.release).not.toHaveBeenCalled()
  })

  it('does NOT call delete() — next() already ran', async () => {
    const { module, store } = makeModule(
      {
        set: jest
          .fn<(key: string, value: IdempotencyRecord, ttlSeconds?: number) => Promise<void>>()
          .mockRejectedValue(new Error('set failed')),
      },
      { onStoreFailure: 'bypass' },
    )
    const ctx = makeCtx()
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.delete).not.toHaveBeenCalled()
  })
})

// ─── Persistence policy ──────────────────────────────────────────────────────

describe('persistence policy', () => {
  it('releases the lock and does not cache 5xx responses', async () => {
    const { module, store } = makeModule()
    const ctx = makeCtx()

    await module.execute(
      ctx,
      makeNext(() => {
        ctx.statusCode = 500
        ctx.response = { error: 'upstream_failure' }
      }),
    )

    expect(store.set).not.toHaveBeenCalled()
    expect(store.release).toHaveBeenCalledWith('test-key-123')
  })
})

// ─── Locked path: acquire() throws ───────────────────────────────────────────

describe('locked path — acquire() throws', () => {
  it('rethrows in strict mode', async () => {
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockRejectedValue(new Error('Redis down')),
      },
      { onStoreFailure: 'strict' },
    )
    await expect(module.execute(makeCtx(), noopHandler)).rejects.toThrow('Redis down')
  })

  it('bypasses to next() in bypass mode', async () => {
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockRejectedValue(new Error('Redis down')),
      },
      { onStoreFailure: 'bypass' },
    )
    const next = makeNext()
    await module.execute(makeCtx(), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('ctx is untouched when bypassing after acquire() failure', async () => {
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockRejectedValue(new Error('Redis down')),
      },
      { onStoreFailure: 'bypass' },
    )
    const ctx = makeCtx()
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = { from: 'handler' }
      }),
    )
    expect(ctx.response).toEqual({ from: 'handler' })
  })
})

// ─── Locked path: get() throws ───────────────────────────────────────────────

describe('locked path — get() throws when acquire() returns false', () => {
  it('rethrows in strict mode', async () => {
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockRejectedValue(new Error('store error')),
      },
      { onStoreFailure: 'strict' },
    )
    await expect(module.execute(makeCtx(), noopHandler)).rejects.toThrow('store error')
  })

  it('falls through to 409 in-progress in bypass mode', async () => {
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockRejectedValue(new Error('store error')),
      },
      { onStoreFailure: 'bypass' },
    )
    const ctx = makeCtx()
    await module.execute(ctx, noopHandler)
    expect(ctx.statusCode).toBe(409)
    expect(ctx.response).toMatchObject({
      error: 'idempotency_key_in_use',
      message: 'A request with this key is already in progress',
    })
  })

  it('includes Retry-After header even when get() throws in bypass mode', async () => {
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockRejectedValue(new Error('store error')),
      },
      { onStoreFailure: 'bypass', processingTtl: 30 },
    )
    const ctx = makeCtx()
    await module.execute(ctx, noopHandler)
    expect(ctx.responseHeaders?.['Retry-After']).toBe('30')
  })
})

// ─── Simple path (no acquire) ─────────────────────────────────────────────────

describe('simple path — store without acquire() (bypass mode only)', () => {
  /**
   * The simple path is for BYOS stores that don't implement acquire().
   * Only reachable in bypass mode — strict mode throws at construction.
   * No concurrency guarantee — two concurrent requests can both execute.
   */
  function makeSimpleStore(overrides: Partial<IdempotencyStore> = {}) {
    const store = makeStore(overrides)
    delete (store as any).acquire
    delete (store as any).release
    return store
  }

  let warnSpy: jest.SpiedFunction<typeof console.warn>

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('warns that idempotency is best-effort only', async () => {
    const store = makeSimpleStore()
    const module = new IdempotencyModule({ store, onStoreFailure: 'bypass' })
    const ctx = makeCtx()
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('best-effort'))
  })

  it('calls next() and executes handler', async () => {
    const store = makeSimpleStore()
    const module = new IdempotencyModule({ store, onStoreFailure: 'bypass' })
    const next = makeNext(() => {})
    await module.execute(makeCtx(), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('checks for existing completed record before executing', async () => {
    const store = makeSimpleStore()
    const module = new IdempotencyModule({ store, onStoreFailure: 'bypass' })
    await module.execute(
      makeCtx(),
      makeNext(() => {}),
    )
    expect(store.get).toHaveBeenCalledTimes(1)
  })

  it('returns cached response if completed record exists', async () => {
    const record: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
    }
    const store = makeSimpleStore({
      get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(record),
    })
    const module = new IdempotencyModule({ store, onStoreFailure: 'bypass' })
    const ctx = makeCtx()
    const next = makeNext()
    await module.execute(ctx, next)
    expect(ctx.response).toEqual({ id: 'order_1' })
    expect(ctx.statusCode).toBe(201)
    expect(ctx.responseHeaders?.['Idempotency-Replayed']).toBe('true')
    expect(next).not.toHaveBeenCalled()
  })

  it('stores completed response after next() succeeds', async () => {
    const store = makeSimpleStore()
    const module = new IdempotencyModule({ store, onStoreFailure: 'bypass' })
    const ctx = makeCtx()
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = { id: 'order_1' }
        ctx.statusCode = 201
      }),
    )
    expect(store.set).toHaveBeenCalledWith(
      'test-key-123',
      { status: 'completed', response: { id: 'order_1' }, statusCode: 201, fingerprint: 'POST' },
      expect.any(Number),
    )
  })

  it('does not call release() for non-cacheable responses when no lock was acquired', async () => {
    const store = makeStore()
    delete (store as any).acquire
    const module = new IdempotencyModule({ store, onStoreFailure: 'bypass' })
    const ctx = makeCtx()

    await module.execute(
      ctx,
      makeNext(() => {
        ctx.statusCode = 422
        ctx.response = { error: 'invalid_request' }
      }),
    )

    expect(store.set).not.toHaveBeenCalled()
    expect(store.release).not.toHaveBeenCalled()
  })

  it('bypasses to next() when get() throws', async () => {
    const store = makeSimpleStore({
      get: jest
        .fn<(key: string) => Promise<IdempotencyRecord | null>>()
        .mockRejectedValue(new Error('store error')),
    })
    const module = new IdempotencyModule({ store, onStoreFailure: 'bypass' })
    const next = makeNext()
    await module.execute(makeCtx(), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('respects duplicateStrategy: reject for cached responses', async () => {
    const record: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
    }
    const store = makeSimpleStore({
      get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(record),
    })
    const module = new IdempotencyModule({
      store,
      onStoreFailure: 'bypass',
      duplicateStrategy: 'reject',
    })
    const ctx = makeCtx()
    await module.execute(ctx, noopHandler)
    expect(ctx.statusCode).toBe(409)
    expect(ctx.response).toMatchObject({ error: 'duplicate_request' })
  })
})

// ─── console output ───────────────────────────────────────────────────────────

describe('console output', () => {
  let errorSpy: jest.SpiedFunction<typeof console.error>
  let warnSpy: jest.SpiedFunction<typeof console.warn>

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('logs set() failure with idempotency key in bypass mode', async () => {
    const { module } = makeModule(
      {
        set: jest
          .fn<(key: string, value: IdempotencyRecord, ttlSeconds?: number) => Promise<void>>()
          .mockRejectedValue(new Error('set failed')),
      },
      { onStoreFailure: 'bypass' },
    )
    const ctx = makeCtx({ headers: { 'idempotency-key': 'my-special-key' } })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('my-special-key'),
      expect.any(Error),
    )
  })

  it('does not log set() failure in strict mode — throws instead', async () => {
    const { module } = makeModule(
      {
        set: jest
          .fn<(key: string, value: IdempotencyRecord, ttlSeconds?: number) => Promise<void>>()
          .mockRejectedValue(new Error('set failed')),
      },
      { onStoreFailure: 'strict' },
    )
    const ctx = makeCtx()
    await expect(
      module.execute(
        ctx,
        makeNext(() => {
          ctx.response = {}
        }),
      ),
    ).rejects.toThrow('set failed')
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('logs release() failure with idempotency key', async () => {
    const { module } = makeModule({
      release: jest
        .fn<(key: string) => Promise<void>>()
        .mockRejectedValue(new Error('release failed')),
    })
    const ctx = makeCtx({ headers: { 'idempotency-key': 'release-key' } })
    await expect(
      module.execute(
        ctx,
        jest.fn<() => Promise<void>>().mockRejectedValue(new Error('handler error')),
      ),
    ).rejects.toThrow('handler error')
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('release-key'), expect.any(Error))
  })
})

// ─── ctx immutability ─────────────────────────────────────────────────────────

describe('ctx properties not mutated unexpectedly', () => {
  it('does not overwrite ctx.body', async () => {
    const { module } = makeModule()
    const ctx = makeCtx({ body: { amount: 100 } })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(ctx.body).toEqual({ amount: 100 })
  })

  it('does not overwrite ctx.method', async () => {
    const { module } = makeModule()
    const ctx = makeCtx({ method: 'POST' })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(ctx.method).toBe('POST')
  })

  it('does not overwrite ctx.path', async () => {
    const { module } = makeModule()
    const ctx = makeCtx({ path: '/payments' })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(ctx.path).toBe('/payments')
  })
})

describe('ctx.headers is absent', () => {
  it('passes through to next() when ctx.headers is null', async () => {
    const { module, store } = makeModule()
    const ctx = makeCtx({ headers: null as any })
    const next = makeNext()

    await module.execute(ctx, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(store.acquire).not.toHaveBeenCalled()
  })
})

// ─── method+path fingerprint strategy — path and query string handling ───────

describe('fingerprintStrategy: method+path — path and query string variations', () => {
  // The fingerprint is stored in the record, not in the store key.
  // acquire() always receives the raw idempotency key — fingerprinting
  // only affects what gets stored in the record and validated on duplicates.

  it('stores correct fingerprint for path without query string', async () => {
    const { module, store } = makeModule({}, { fingerprintStrategy: 'method+path' })
    const ctx = makeCtx({ path: '/orders/123', headers: { 'idempotency-key': 'order-123' } })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        fingerprint: createHash('sha256').update('POST:/orders/123').digest('hex'),
      }),
      expect.any(Number),
    )
  })

  it('stores correct fingerprint for path with query string', async () => {
    const { module, store } = makeModule({}, { fingerprintStrategy: 'method+path' })
    const ctx = makeCtx({
      path: '/orders?param=value',
      headers: { 'idempotency-key': 'order-123' },
    })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        fingerprint: createHash('sha256').update('POST:/orders?param=value').digest('hex'),
      }),
      expect.any(Number),
    )
  })

  it('stores correct fingerprint for path with dynamic segment and query string', async () => {
    const { module, store } = makeModule({}, { fingerprintStrategy: 'method+path' })
    const ctx = makeCtx({
      path: '/orders/123?param=value',
      headers: { 'idempotency-key': 'order-123' },
    })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        fingerprint: createHash('sha256').update('POST:/orders/123?param=value').digest('hex'),
      }),
      expect.any(Number),
    )
  })

  it('normalizes trailing slash — /orders/123/ and /orders/123 produce same fingerprint', async () => {
    const expectedFingerprint = createHash('sha256').update('POST:/orders/123').digest('hex')
    const record: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
      fingerprint: expectedFingerprint,
    }
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockResolvedValue(record),
      },
      { fingerprintStrategy: 'method+path' },
    )
    // Trailing slash — should match fingerprint stored without it
    const ctx = makeCtx({ path: '/orders/123/', headers: { 'idempotency-key': 'order-123' } })
    await module.execute(ctx, noopHandler)
    expect(ctx.statusCode).toBe(201) // matched — not 422
  })

  it('different paths produce different fingerprints → 422', async () => {
    const record: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
      fingerprint: createHash('sha256').update('POST:/orders/123').digest('hex'),
    }
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockResolvedValue(record),
      },
      { fingerprintStrategy: 'method+path' },
    )
    // Different dynamic segment — different operation
    const ctx = makeCtx({ path: '/orders/456', headers: { 'idempotency-key': 'order-123' } })
    await module.execute(ctx, noopHandler)
    expect(ctx.statusCode).toBe(422)
  })

  it('different query params produce different fingerprints → 422', async () => {
    const record: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
      fingerprint: createHash('sha256').update('POST:/orders?amount=100').digest('hex'),
    }
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockResolvedValue(record),
      },
      { fingerprintStrategy: 'method+path' },
    )
    const ctx = makeCtx({ path: '/orders?amount=999', headers: { 'idempotency-key': 'order-123' } })
    await module.execute(ctx, noopHandler)
    expect(ctx.statusCode).toBe(422)
  })

  it('normalizes query param order — ?b=2&a=1 same fingerprint as ?a=1&b=2', async () => {
    const expectedFingerprint = createHash('sha256').update('POST:/orders?a=1&b=2').digest('hex')
    const record: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
      fingerprint: expectedFingerprint,
    }
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockResolvedValue(record),
      },
      { fingerprintStrategy: 'method+path' },
    )
    const ctx = makeCtx({ path: '/orders?b=2&a=1', headers: { 'idempotency-key': 'order-123' } })
    await module.execute(ctx, noopHandler)
    expect(ctx.statusCode).toBe(201) // matched — not 422
  })

  it('falls back to the root path for method+path fingerprinting when ctx.path is empty', async () => {
    const { module, store } = makeModule({}, { fingerprintStrategy: 'method+path' })
    const ctx = makeCtx({
      path: '',
      headers: { 'idempotency-key': 'order-123' },
    })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        fingerprint: createHash('sha256').update('POST:/').digest('hex'),
      }),
      expect.any(Number),
    )
  })

  it('acquire() scopes the key by method and normalized path — not by fingerprint hash', async () => {
    const { module, store } = makeModule({}, { fingerprintStrategy: 'method+path' })
    const ctx = makeCtx({
      path: '/orders/123?param=value',
      headers: { 'idempotency-key': 'order-123' },
    })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.acquire).toHaveBeenCalledWith('order-123', expect.any(Number))
  })
})

// ─── full fingerprint strategy — path, query string, and body handling ────────

describe('fingerprintStrategy: full — path, query string, and body variations', () => {
  it('stores correct fingerprint for path without query string', async () => {
    const body = { amount: 100 }
    const expected = createHash('sha256')
      .update(`POST:/orders/123:${JSON.stringify(body)}`)
      .digest('hex')
    const { module, store } = makeModule({}, { fingerprintStrategy: 'full' })
    const ctx = makeCtx({ path: '/orders/123', body, headers: { 'idempotency-key': 'order-123' } })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ fingerprint: expected }),
      expect.any(Number),
    )
  })

  it('stores correct fingerprint for path with query string', async () => {
    const body = { amount: 100 }
    const expected = createHash('sha256')
      .update(`POST:/orders?param=value:${JSON.stringify(body)}`)
      .digest('hex')
    const { module, store } = makeModule({}, { fingerprintStrategy: 'full' })
    const ctx = makeCtx({
      path: '/orders?param=value',
      body,
      headers: { 'idempotency-key': 'order-123' },
    })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ fingerprint: expected }),
      expect.any(Number),
    )
  })

  it('stores correct fingerprint for path with dynamic segment and query string', async () => {
    const body = { amount: 100 }
    const expected = createHash('sha256')
      .update(`POST:/orders/123?param=value:${JSON.stringify(body)}`)
      .digest('hex')
    const { module, store } = makeModule({}, { fingerprintStrategy: 'full' })
    const ctx = makeCtx({
      path: '/orders/123?param=value',
      body,
      headers: { 'idempotency-key': 'order-123' },
    })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ fingerprint: expected }),
      expect.any(Number),
    )
  })

  it('normalizes trailing slash in full fingerprint', async () => {
    const body = { amount: 100 }
    const expectedFingerprint = createHash('sha256')
      .update(`POST:/orders/123:${JSON.stringify(body)}`)
      .digest('hex')
    const record: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
      fingerprint: expectedFingerprint,
    }
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockResolvedValue(record),
      },
      { fingerprintStrategy: 'full' },
    )
    const ctx = makeCtx({ path: '/orders/123/', body, headers: { 'idempotency-key': 'order-123' } })
    await module.execute(ctx, noopHandler)
    expect(ctx.statusCode).toBe(201) // matched — not 422
  })

  it('different body with same path produces different fingerprint → 422', async () => {
    const record: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
      fingerprint: createHash('sha256')
        .update(`POST:/orders/123:${JSON.stringify({ amount: 100 })}`)
        .digest('hex'),
    }

    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockResolvedValue(record),
      },
      { fingerprintStrategy: 'full' },
    )
    const ctx = makeCtx({
      path: '/orders/123',
      body: { amount: 999 },
      headers: { 'idempotency-key': 'order-123' },
    })
    await module.execute(ctx, noopHandler)
    expect(ctx.statusCode).toBe(422)
  })

  it('same path, same body, different query string → 422', async () => {
    const body = { amount: 100 }
    const record: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
      fingerprint: createHash('sha256')
        .update(`POST:/orders?currency=USD:${JSON.stringify(body)}`)
        .digest('hex'),
    }
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockResolvedValue(record),
      },
      { fingerprintStrategy: 'full' },
    )
    const ctx = makeCtx({
      path: '/orders?currency=EUR',
      body,
      headers: { 'idempotency-key': 'order-123' },
    })
    await module.execute(ctx, noopHandler)
    expect(ctx.statusCode).toBe(422)
  })

  it('same path, empty body, different query string → 422', async () => {
    const body = undefined
    const record: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
      fingerprint: createHash('sha256')
        .update(`POST:/orders?currency=USD:${JSON.stringify(body ?? {})}`)
        .digest('hex'),
    }
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockResolvedValue(record),
      },
      { fingerprintStrategy: 'full' },
    )
    const ctx = makeCtx({
      path: '/orders?currency=EUR',
      body,
      headers: { 'idempotency-key': 'order-123' },
    })
    await module.execute(ctx, noopHandler)
    expect(ctx.statusCode).toBe(422)
  })

  it('root path with empty body and no query string → 201 cache hit', async () => {
    const body = undefined
    const record: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
      fingerprint: createHash('sha256')
        .update(`POST:/:${JSON.stringify(body ?? {})}`)
        .digest('hex'),
    }
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockResolvedValue(record),
      },
      { fingerprintStrategy: 'full' },
    )
    const ctx = makeCtx({
      path: '/',
      body,
      headers: { 'idempotency-key': 'order-123' },
    })
    await module.execute(ctx, noopHandler)
    expect(ctx.statusCode).toBe(201)
  })

  it('falls back to the root path in full fingerprinting when ctx.path is empty', async () => {
    const body = undefined
    const { module, store } = makeModule({}, { fingerprintStrategy: 'full' })
    const ctx = makeCtx({
      path: '',
      body,
      headers: { 'idempotency-key': 'order-123' },
    })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        fingerprint: createHash('sha256')
          .update(`POST:/:${JSON.stringify(body ?? {})}`)
          .digest('hex'),
      }),
      expect.any(Number),
    )
  })

  it('normalizes query param order in full fingerprint', async () => {
    const body = { amount: 100 }
    const expectedFingerprint = createHash('sha256')
      .update(`POST:/orders?a=1&b=2:${JSON.stringify(body)}`)
      .digest('hex')
    const record: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
      fingerprint: expectedFingerprint,
    }
    const { module } = makeModule(
      {
        acquire: jest
          .fn<(key: string, ttl?: number) => Promise<boolean>>()
          .mockResolvedValue(false),
        get: jest
          .fn<(key: string) => Promise<IdempotencyRecord | null>>()
          .mockResolvedValue(record),
      },
      { fingerprintStrategy: 'full' },
    )
    const ctx = makeCtx({
      path: '/orders?b=2&a=1',
      body,
      headers: { 'idempotency-key': 'order-123' },
    })
    await module.execute(ctx, noopHandler)
    expect(ctx.statusCode).toBe(201) // matched — not 422
  })

  it('acquire() receives a scoped key that still includes the raw idempotency key', async () => {
    const { module, store } = makeModule({}, { fingerprintStrategy: 'full' })
    const ctx = makeCtx({
      path: '/orders/123?param=value',
      body: { amount: 100 },
      headers: { 'idempotency-key': 'order-123' },
    })
    await module.execute(
      ctx,
      makeNext(() => {
        ctx.response = {}
      }),
    )
    expect(store.acquire).toHaveBeenCalledWith('order-123', expect.any(Number))
  })
})
