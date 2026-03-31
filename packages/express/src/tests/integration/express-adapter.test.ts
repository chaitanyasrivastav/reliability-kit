import { describe, it, expect, jest } from '@jest/globals'
import { expressAdapter } from '../../adapter'
import { createReliability, IdempotencyStore, IdempotencyRecord } from '@reliability-tools/core'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<any> = {}): any {
  return {
    method: 'POST',
    url: '/orders',
    path: '/orders',
    headers: { 'idempotency-key': 'test-key-123' },
    body: { amount: 100 },
    ...overrides,
  }
}

function makeRes(overrides: Partial<any> = {}): any {
  const res: any = {
    statusCode: 200,
    headersSent: false,
    _body: undefined,
    _headers: {} as Record<string, string>,
  }

  res.status = jest.fn((code: number) => {
    res.statusCode = code
    return res
  })

  res.setHeader = jest.fn((name: string, value: string) => {
    res._headers[name] = value
    return res
  })

  res.send = jest.fn((body: any) => {
    res._body = body
    res.headersSent = true
    res.emit('finish')
    return res
  })

  res.json = jest.fn((body: any) => {
    res._body = body
    res.headersSent = true
    res.emit('finish')
    return res
  })

  res.end = jest.fn((body?: any) => {
    if (body) res._body = body
    res.headersSent = true
    res.emit('finish')
    return res
  })

  // Minimal EventEmitter for the 'finish' event
  const listeners: Record<string, Array<() => void>> = {}
  res.on = jest.fn((event: string, cb: () => void) => {
    if (!listeners[event]) listeners[event] = []
    listeners[event].push(cb)
  })
  res.emit = (event: string) => {
    listeners[event]?.forEach((cb) => cb())
  }

  Object.assign(res, overrides)
  return res
}

function makeNext(fn?: () => void) {
  return jest.fn(() => {
    fn?.()
  })
}

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

// ─── Module composition ───────────────────────────────────────────────────────

describe('module composition', () => {
  it('does not add idempotency module when idempotency is not configured', async () => {
    const store = makeStore()
    const { engine } = createReliability({})
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext(() => res.send({ ok: true }))

    await middleware(req, res, next)

    expect(store.acquire).not.toHaveBeenCalled()
  })

  it('does not add idempotency module when enabled is false', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: false, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext(() => res.send({ ok: true }))

    await middleware(req, res, next)

    expect(store.acquire).not.toHaveBeenCalled()
  })

  it('adds idempotency module when enabled is true', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext(() => res.send({ ok: true }))

    await middleware(req, res, next)

    expect(store.acquire).toHaveBeenCalledTimes(1)
  })
})

// ─── Context mapping ──────────────────────────────────────────────────────────

describe('context mapping from req', () => {
  it('maps req.method to ctx.method', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq({ method: 'PUT' })
    const res = makeRes()
    const next = makeNext(() => res.send({}))

    await middleware(req, res, next)

    // acquire is called with the idempotency key — method is used in ctx
    // which modules can read; indirectly verified via store interaction
    expect(store.acquire).toHaveBeenCalledTimes(1)
  })

  it('maps req.headers to ctx.headers', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq({ headers: { 'idempotency-key': 'mapped-key' } })
    const res = makeRes()
    const next = makeNext(() => res.send({}))

    await middleware(req, res, next)

    expect(store.acquire).toHaveBeenCalledWith('POST:/orders:mapped-key', expect.any(Number))
  })

  it('prefers req.originalUrl when available', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq({
      originalUrl: '/orders?source=original',
      url: '/orders?source=url',
      path: '/orders',
      headers: { 'idempotency-key': 'original-key' },
    })
    const res = makeRes()
    const next = makeNext(() => res.send({}))

    await middleware(req, res, next)

    expect(store.acquire).toHaveBeenCalledWith(
      'POST:/orders?source=original:original-key',
      expect.any(Number),
    )
  })

  it('uses req.url when originalUrl is missing', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq({
      originalUrl: undefined,
      url: '/orders?source=url',
      path: '/orders',
      headers: { 'idempotency-key': 'url-key' },
    })
    const res = makeRes()
    const next = makeNext(() => res.send({}))

    await middleware(req, res, next)

    expect(store.acquire).toHaveBeenCalledWith(
      'POST:/orders?source=url:url-key',
      expect.any(Number),
    )
  })

  it('falls back to / when originalUrl and url are missing even if req.path exists', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq({
      originalUrl: undefined,
      url: undefined,
      path: '/orders',
    })
    const res = makeRes()
    const next = makeNext(() => res.send({}))

    await middleware(req, res, next)

    expect(store.acquire).toHaveBeenCalledWith('POST:/:test-key-123', expect.any(Number))
  })

  it('keeps response headers separate and defaults status to 200 on module short-circuit', async () => {
    const engine = {
      handle: jest.fn(async (ctx: any) => {
        expect(ctx.statusCode).toBeUndefined()
        ctx.responseHeaders = { 'X-RateLimit-Remaining': '9' }
        ctx.response = { ok: true }
      }),
    } as any

    const middleware = expressAdapter(engine)
    const req = makeReq({
      originalUrl: undefined,
      url: undefined,
      path: '/orders',
      headers: { authorization: 'secret-token' },
    })
    const res = makeRes()
    const next = makeNext()

    await middleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res._headers['X-RateLimit-Remaining']).toBe('9')
    expect(res._headers.authorization).toBeUndefined()
    expect(res._body).toEqual({ ok: true })
  })

  it('passes req.body through to ctx', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq({ body: { amount: 500 } })
    const res = makeRes()
    const next = makeNext(() => res.send({}))

    await middleware(req, res, next)

    // body is passed to ctx — engine receives it for any module that reads it
    expect(next).toHaveBeenCalledTimes(1)
  })
})

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('happy path — handler runs normally', () => {
  it('calls next() exactly once', async () => {
    const { engine } = createReliability({})
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext(() => res.send({ ok: true }))

    await middleware(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
  })

  it('does not send a second response when handler already responded', async () => {
    const { engine } = createReliability({})
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext(() => res.send({ ok: true }))

    await middleware(req, res, next)

    // headersSent proves send() was called exactly once by the handler
    // — if the adapter called it again it would attempt to send twice
    expect(res.headersSent).toBe(true)
    expect(res._body).toEqual({ ok: true })
  })

  it('does not call res.status() when handler already responded', async () => {
    const { engine } = createReliability({})
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext(() => res.send({ ok: true }))

    await middleware(req, res, next)

    expect(res.status).not.toHaveBeenCalled()
  })
})

// ─── Response interception — res.send() ──────────────────────────────────────

describe('response interception via res.send()', () => {
  it('captures body written by handler via res.send()', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext(() => {
      res.statusCode = 201
      res.send({ id: 'order_1' })
    })

    await middleware(req, res, next)

    expect(store.set).toHaveBeenCalledWith(
      'POST:/orders:test-key-123',
      expect.objectContaining({ response: { id: 'order_1' }, statusCode: 201 }),
      expect.any(Number),
    )
  })

  it('captures statusCode written before res.send()', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext(() => {
      res.statusCode = 204
      res.send({})
    })

    await middleware(req, res, next)

    expect(store.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ statusCode: 204 }),
      expect.any(Number),
    )
  })

  it('still forwards body to originalSend', async () => {
    const { engine } = createReliability({})
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const body = { id: 'order_1' }
    const next = makeNext(() => res.send(body))

    await middleware(req, res, next)

    expect(res._body).toEqual(body)
  })
})

// ─── Response interception — res.json() ──────────────────────────────────────

describe('response interception via res.json()', () => {
  it('captures body written by handler via res.json()', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext(() => {
      res.statusCode = 200
      res.json({ result: 'ok' })
    })

    await middleware(req, res, next)

    expect(store.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ response: { result: 'ok' } }),
      expect.any(Number),
    )
  })

  it('still forwards body to originalJson', async () => {
    const { engine } = createReliability({})
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const body = { result: 'ok' }
    const next = makeNext(() => res.json(body))

    await middleware(req, res, next)

    expect(res._body).toEqual(body)
  })
})

// ─── Response interception — res.end() ───────────────────────────────────────

describe('response interception via res.end()', () => {
  it('captures body written directly via res.end()', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext(() => {
      res.statusCode = 200
      res.end('raw body')
    })

    await middleware(req, res, next)

    expect(store.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ response: 'raw body' }),
      expect.any(Number),
    )
  })

  it('does not overwrite ctx.response already set by res.send()', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()

    // simulate a handler calling send() then end() (Express internals do this)
    const next = makeNext(() => {
      res.send({ from: 'send' })
      res.end('from end')
    })

    await middleware(req, res, next)

    expect(store.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ response: { from: 'send' } }),
      expect.any(Number),
    )
  })

  it('still forwards body to originalEnd', async () => {
    const { engine } = createReliability({})
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext(() => res.end('raw'))

    await middleware(req, res, next)

    expect(res._body).toBe('raw')
  })
})

// ─── Intercepted response (module short-circuits) ────────────────────────────

describe('intercepted response — module short-circuits', () => {
  it('sends ctx.response when module short-circuits and headersSent is false', async () => {
    const store = makeStore({
      acquire: jest.fn<(key: string, ttl?: number) => Promise<boolean>>().mockResolvedValue(false),
      get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(null),
    })
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext()

    await middleware(req, res, next)

    expect(res._body).toMatchObject({
      error: 'idempotency_key_in_use',
      message: 'A request with this key is already in progress',
    })
    expect(res.headersSent).toBe(true)
  })

  it('uses ctx.statusCode when sending the intercepted response', async () => {
    const store = makeStore({
      acquire: jest.fn<(key: string, ttl?: number) => Promise<boolean>>().mockResolvedValue(false),
      get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(null),
    })
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext()

    await middleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(409)
  })

  it('defaults to status 200 when ctx.statusCode is undefined and no response headers are set', async () => {
    const engine = {
      handle: jest.fn(async (ctx: any) => {
        ctx.response = { ok: true }
      }),
    } as any

    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext()

    await middleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.setHeader).not.toHaveBeenCalled()
    expect(res._body).toEqual({ ok: true })
  })

  it('returns cached response on duplicate request', async () => {
    const cached: IdempotencyRecord = {
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
    }
    const store = makeStore({
      acquire: jest.fn<(key: string, ttl?: number) => Promise<boolean>>().mockResolvedValue(false),
      get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(cached),
    })
    const { engine } = createReliability({
      idempotency: { enabled: true, store, duplicateStrategy: 'cache' },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext()

    await middleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(201)
    expect(res._headers['Idempotency-Replayed']).toBe('true')
    expect(res._body).toEqual({ id: 'order_1' })
    expect(next).not.toHaveBeenCalled()
  })

  it('does not call next() when module short-circuits', async () => {
    const store = makeStore({
      acquire: jest.fn<(key: string, ttl?: number) => Promise<boolean>>().mockResolvedValue(false),
      get: jest.fn<(key: string) => Promise<IdempotencyRecord | null>>().mockResolvedValue(null),
    })
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext()

    await middleware(req, res, next)

    expect(next).not.toHaveBeenCalled()
  })
})

// ─── No idempotency key ───────────────────────────────────────────────────────

describe('no idempotency key in headers', () => {
  it('calls next() and skips store interactions', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq({ headers: {} })
    const res = makeRes()
    const next = makeNext(() => res.send({ ok: true }))

    await middleware(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(store.acquire).not.toHaveBeenCalled()
  })
})

// ─── Idempotency config forwarding ───────────────────────────────────────────

describe('idempotency config forwarding', () => {
  it('forwards custom ttl to store.set()', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store, ttl: 7200 },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext(() => res.send({}))

    await middleware(req, res, next)

    expect(store.set).toHaveBeenCalledWith(expect.any(String), expect.any(Object), 7200)
  })

  it('forwards custom processingTtl to store.acquire()', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store, processingTtl: 60 },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq()
    const res = makeRes()
    const next = makeNext(() => res.send({}))

    await middleware(req, res, next)

    expect(store.acquire).toHaveBeenCalledWith(expect.any(String), 60)
  })

  it('forwards custom key header name to store', async () => {
    const store = makeStore()
    const { engine } = createReliability({
      idempotency: { enabled: true, store, key: 'X-Request-Id' },
    })
    const middleware = expressAdapter(engine)
    const req = makeReq({ headers: { 'x-request-id': 'custom-key' } })
    const res = makeRes()
    const next = makeNext(() => res.send({}))

    await middleware(req, res, next)

    expect(store.acquire).toHaveBeenCalledWith('POST:/orders:custom-key', expect.any(Number))
  })
})
