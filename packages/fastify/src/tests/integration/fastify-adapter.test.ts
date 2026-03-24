import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { fastifyAdapter } from '../../adapter'
import { createReliability, IdempotencyStore, IdempotencyRecord } from '@reliability/core'

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Creates a Fastify app with the adapter's wrapper function applied to /orders.
 * Uses inject() for end-to-end testing without a real HTTP server.
 *
 * The wrapper pattern — protect(handler) — is applied directly to the route,
 * matching exactly how users register routes with the Fastify adapter.
 */
async function makeApp(
  store: IdempotencyStore,
  routeHandler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  configOverrides: any = {},
): Promise<FastifyInstance> {
  const app = Fastify()
  const { engine } = createReliability({
    idempotency: {
      enabled: true,
      store,
      ...configOverrides,
    },
  })
  const protect = fastifyAdapter(engine)

  app.post('/orders', protect(routeHandler))

  await app.ready()
  return app
}

const noopHandler = async (_req: FastifyRequest, reply: FastifyReply) => {
  await reply.send({ ok: true })
}

// ─── Module composition ───────────────────────────────────────────────────────

describe('module composition', () => {
  it('does not interact with store when idempotency is not configured', async () => {
    const store = makeStore()
    const app = Fastify()
    const { engine } = createReliability({})
    const protect = fastifyAdapter(engine)

    // No idempotency — plain wrapper with no modules
    app.post('/orders', protect(noopHandler))
    await app.ready()

    await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'k1' },
    })

    expect(store.acquire).not.toHaveBeenCalled()
    await app.close()
  })

  it('does not interact with store when enabled is false', async () => {
    const store = makeStore()
    const app = Fastify()
    const { engine } = createReliability({
      idempotency: { enabled: false, store },
    })
    const protect = fastifyAdapter(engine)
    app.post('/orders', protect(noopHandler))
    await app.ready()

    await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'k1' },
    })

    expect(store.acquire).not.toHaveBeenCalled()
    await app.close()
  })

  it('calls acquire() when idempotency is enabled', async () => {
    const store = makeStore()
    const app = await makeApp(store, noopHandler)

    await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'k1' },
    })

    expect(store.acquire).toHaveBeenCalledTimes(1)
    await app.close()
  })
})

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('happy path — handler runs normally', () => {
  let app: FastifyInstance
  let store: jest.Mocked<IdempotencyStore>

  beforeEach(async () => {
    store = makeStore()
    app = await makeApp(store, async (_req, reply) => {
      reply.status(201).send({ id: 'order_1' })
    })
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns handler response with correct status', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'key-abc' },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toEqual({ id: 'order_1' })
  })

  it('calls acquire() exactly once', async () => {
    await app.inject({ method: 'POST', url: '/orders', headers: { 'idempotency-key': 'key-abc' } })
    expect(store.acquire).toHaveBeenCalledTimes(1)
  })

  it('calls acquire() with the correct idempotency key', async () => {
    await app.inject({ method: 'POST', url: '/orders', headers: { 'idempotency-key': 'my-key' } })
    expect(store.acquire).toHaveBeenCalledWith('my-key', expect.any(Number))
  })

  it('stores completed response with correct shape after handler runs', async () => {
    await app.inject({ method: 'POST', url: '/orders', headers: { 'idempotency-key': 'key-abc' } })

    expect(store.set).toHaveBeenCalledWith(
      'key-abc',
      expect.objectContaining({ status: 'completed', statusCode: 201 }),
      expect.any(Number),
    )
  })

  it('does not call get() on happy path', async () => {
    await app.inject({ method: 'POST', url: '/orders', headers: { 'idempotency-key': 'key-abc' } })
    expect(store.get).not.toHaveBeenCalled()
  })

  it('does not call release() on happy path', async () => {
    await app.inject({ method: 'POST', url: '/orders', headers: { 'idempotency-key': 'key-abc' } })
    expect(store.release).not.toHaveBeenCalled()
  })

  it('does not call delete() on happy path', async () => {
    await app.inject({ method: 'POST', url: '/orders', headers: { 'idempotency-key': 'key-abc' } })
    expect(store.delete).not.toHaveBeenCalled()
  })
})

// ─── No idempotency key ───────────────────────────────────────────────────────

describe('no idempotency key in headers', () => {
  it('passes through to handler and skips all store interactions', async () => {
    const store = makeStore()
    const app = await makeApp(store, noopHandler)

    const res = await app.inject({ method: 'POST', url: '/orders' })

    expect(res.statusCode).toBe(200)
    expect(store.acquire).not.toHaveBeenCalled()
    expect(store.get).not.toHaveBeenCalled()
    expect(store.set).not.toHaveBeenCalled()
    await app.close()
  })
})

// ─── Duplicate requests ───────────────────────────────────────────────────────

describe('duplicate requests', () => {
  it('returns 409 in-progress when record is still processing', async () => {
    const store = makeStore({
      acquire: jest.fn<(key: string, ttl?: number) => Promise<boolean>>().mockResolvedValue(false),
      get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(null),
    })
    const app = await makeApp(store, noopHandler)

    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'dup-key' },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Request already in progress' })
    await app.close()
  })

  it('includes Retry-After header on 409 in-progress', async () => {
    const store = makeStore({
      acquire: jest.fn<(key: string, ttl?: number) => Promise<boolean>>().mockResolvedValue(false),
      get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(null),
    })
    const app = await makeApp(store, noopHandler, { processingTtl: 30 })

    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'dup-key' },
    })

    expect(res.headers['retry-after']).toBe('30')
    expect(JSON.parse(res.body)).toMatchObject({ retryAfter: 30 })
    await app.close()
  })

  it('returns cached response when completed and strategy is cache', async () => {
    const cached: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
    }
    const store = makeStore({
      acquire: jest.fn<(key: string, ttl?: number) => Promise<boolean>>().mockResolvedValue(false),
      get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(cached),
    })
    const app = await makeApp(store, noopHandler, { duplicateStrategy: 'cache' })

    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'dup-key' },
    })

    expect(res.statusCode).toBe(201)
    await app.close()
  })

  it('returns 409 reject when completed and strategy is reject', async () => {
    const cached: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
    }
    const store = makeStore({
      acquire: jest.fn<(key: string, ttl?: number) => Promise<boolean>>().mockResolvedValue(false),
      get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(cached),
    })
    const app = await makeApp(store, noopHandler, { duplicateStrategy: 'reject' })

    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'dup-key' },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Duplicate request' })
    await app.close()
  })

  it('does not execute handler on duplicate', async () => {
    const handler = jest.fn(async (_req: FastifyRequest, reply: FastifyReply) => {
      await reply.send({ ok: true })
    })
    const store = makeStore({
      acquire: jest.fn<(key: string, ttl?: number) => Promise<boolean>>().mockResolvedValue(false),
      get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(null),
    })
    const app = await makeApp(store, handler)

    await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'dup-key' },
    })

    expect(handler).not.toHaveBeenCalled()
    await app.close()
  })
})

// ─── Response capture ─────────────────────────────────────────────────────────

describe('response capture via reply.send() interception', () => {
  it('captures response body written by handler', async () => {
    const store = makeStore()
    const app = await makeApp(store, async (_req, reply) => {
      reply.status(201).send({ id: 'order_1', created: true })
    })

    await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'capture-key' },
    })

    expect(store.set).toHaveBeenCalledWith(
      'capture-key',
      expect.objectContaining({ status: 'completed', statusCode: 201 }),
      expect.any(Number),
    )
    await app.close()
  })

  it('captures correct statusCode from handler', async () => {
    const store = makeStore()
    const app = await makeApp(store, async (_req, reply) => {
      reply.status(422).send({ error: 'invalid' })
    })

    await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'status-key' },
    })

    expect(store.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ statusCode: 422 }),
      expect.any(Number),
    )
    await app.close()
  })
})

// ─── Context mapping ──────────────────────────────────────────────────────────

describe('context mapping from request', () => {
  it('passes exact idempotency key to store', async () => {
    const store = makeStore()
    const app = await makeApp(store, noopHandler)

    await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'exact-key' },
    })

    expect(store.acquire).toHaveBeenCalledWith('exact-key', expect.any(Number))
    await app.close()
  })

  it('reads idempotency key case-insensitively via custom header name', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store, key: 'X-Request-Id' },
    })
    const protect = fastifyAdapter(engine)
    const app = Fastify()
    app.post('/orders', protect(noopHandler))
    await app.ready()

    await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'x-request-id': 'custom-key' },
    })

    expect(store.acquire).toHaveBeenCalledWith('custom-key', expect.any(Number))
    await app.close()
  })
})

// ─── Config forwarding ────────────────────────────────────────────────────────

describe('idempotency config forwarding', () => {
  it('forwards custom processingTtl to acquire()', async () => {
    const store = makeStore()
    const app = await makeApp(store, noopHandler, { processingTtl: 60 })

    await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'ttl-key' },
    })

    expect(store.acquire).toHaveBeenCalledWith(expect.any(String), 60)
    await app.close()
  })

  it('forwards custom ttl to store.set()', async () => {
    const store = makeStore()
    const app = await makeApp(store, noopHandler, { ttl: 7200 })

    await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'ttl-key' },
    })

    expect(store.set).toHaveBeenCalledWith(expect.any(String), expect.any(Object), 7200)
    await app.close()
  })
})

// ─── Store failure modes ──────────────────────────────────────────────────────

describe('store failure modes', () => {
  it('throws when acquire() fails in strict mode', async () => {
    const store = makeStore({
      acquire: jest
        .fn<(key: string, ttl?: number) => Promise<boolean>>()
        .mockRejectedValue(new Error('Redis down')),
    })
    const app = Fastify()
    app.setErrorHandler(async (err: Error, _req, reply) => {
      reply.status(500).send({ error: err.message })
    })
    const { engine } = createReliability({
      idempotency: { enabled: true, store, onStoreFailure: 'strict' },
    })
    const protect = fastifyAdapter(engine)
    app.post('/orders', protect(noopHandler))
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'fail-key' },
    })

    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Redis down' })
    await app.close()
  })

  it('proceeds normally when acquire() fails in bypass mode', async () => {
    const store = makeStore({
      acquire: jest
        .fn<(key: string, ttl?: number) => Promise<boolean>>()
        .mockRejectedValue(new Error('Redis down')),
    })
    const app = Fastify()
    const { engine } = createReliability({
      idempotency: { enabled: true, store, onStoreFailure: 'bypass' },
    })
    const protect = fastifyAdapter(engine)
    app.post('/orders', protect(noopHandler))
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'fail-key' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    await app.close()
  })
})

// ─── Wrapper is per-route ─────────────────────────────────────────────────────

describe('wrapper function — per-route control', () => {
  it('only protects wrapped routes — unwrapped routes bypass idempotency', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const protect = fastifyAdapter(engine)
    const app = Fastify()

    // Protected route
    app.post('/orders', protect(noopHandler))

    // Unwrapped route — no idempotency
    app.get('/health', async (_req, reply) => reply.send({ ok: true }))

    await app.ready()

    await app.inject({ method: 'GET', url: '/health' })
    expect(store.acquire).not.toHaveBeenCalled()

    await app.inject({ method: 'POST', url: '/orders', headers: { 'idempotency-key': 'k1' } })
    expect(store.acquire).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('applies independently to each wrapped route', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const protect = fastifyAdapter(engine)
    const app = Fastify()

    app.post('/orders', protect(noopHandler))
    app.post('/payments', protect(noopHandler))
    await app.ready()

    await app.inject({ method: 'POST', url: '/orders', headers: { 'idempotency-key': 'k1' } })
    await app.inject({ method: 'POST', url: '/payments', headers: { 'idempotency-key': 'k2' } })

    expect(store.acquire).toHaveBeenCalledTimes(2)
    expect(store.acquire).toHaveBeenCalledWith('k1', expect.any(Number))
    expect(store.acquire).toHaveBeenCalledWith('k2', expect.any(Number))

    await app.close()
  })
})
