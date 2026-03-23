import { describe, it, expect, jest } from '@jest/globals'
import { RedisStore, RedisClient } from '../../modules/idempotency/stores/redis-store'
import { IdempotencyRecord } from '../../modules/idempotency/stores/store'

// ─── Redis stub ───────────────────────────────────────────────────────────────
//
// Simulates Redis SET NX EX / GET / DEL without a real Redis instance.
// Faithfully implements SET NX semantics — returns 'OK' on success, null
// if key already exists — matching the behaviour RedisStore depends on.

function makeRedisStub() {
  const db = new Map<string, string>()

  const client: jest.Mocked<RedisClient> = {
    get: jest.fn(async (key: string) => db.get(key) ?? null),

    set: jest.fn(async (key: string, value: string, ...args: any[]) => {
      const isNX = args.includes('NX')
      if (isNX && db.has(key)) return null
      db.set(key, value)
      return 'OK'
    }),

    del: jest.fn(async (key: string) => {
      const existed = db.has(key)
      db.delete(key)
      return existed ? 1 : 0
    }),
  }

  // Expose db for white-box assertions where needed
  return { client, db }
}

const COMPLETED: IdempotencyRecord = {
  status: 'completed',
  response: { id: 'order_1' },
  statusCode: 201,
}

// ─── Constructor ──────────────────────────────────────────────────────────────

describe('constructor', () => {
  it('throws if client is null', () => {
    expect(() => new RedisStore(null as any)).toThrow('Invalid Redis client')
  })

  it('throws if get() is missing', () => {
    expect(() => new RedisStore({ set: jest.fn(), del: jest.fn() } as any)).toThrow(
      'Invalid Redis client',
    )
  })

  it('throws if set() is missing', () => {
    expect(() => new RedisStore({ get: jest.fn(), del: jest.fn() } as any)).toThrow(
      'Invalid Redis client',
    )
  })

  it('throws if del() is missing', () => {
    expect(() => new RedisStore({ get: jest.fn(), set: jest.fn() } as any)).toThrow(
      'Invalid Redis client',
    )
  })

  it('does not throw with a valid client', () => {
    const { client } = makeRedisStub()
    expect(() => new RedisStore(client)).not.toThrow()
  })
})

// ─── Key namespacing ──────────────────────────────────────────────────────────

describe('key namespacing', () => {
  it('prefixes acquire() key with "idem:"', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.acquire('my-key', 30)
    expect(client.set).toHaveBeenCalledWith('idem:my-key', expect.any(String), 'NX', 'EX', 30)
  })

  it('prefixes get() key with "idem:"', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.get('my-key')
    expect(client.get).toHaveBeenCalledWith('idem:my-key')
  })

  it('prefixes set() key with "idem:"', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('my-key', COMPLETED, 60)
    expect(client.set).toHaveBeenCalledWith('idem:my-key', expect.any(String), 'EX', 60)
  })

  it('prefixes delete() key with "idem:"', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.delete('my-key')
    expect(client.del).toHaveBeenCalledWith('idem:my-key')
  })

  it('prefixes release() get and del with "idem:"', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.acquire('my-key', 30)
    client.get.mockClear()
    client.del.mockClear()
    await store.release('my-key')
    expect(client.get).toHaveBeenCalledWith('idem:my-key')
    expect(client.del).toHaveBeenCalledWith('idem:my-key')
  })

  it('two different raw keys do not collide under the same namespace', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('key-a', { status: 'completed', response: { a: 1 }, statusCode: 200 }, 60)
    await store.set('key-b', { status: 'completed', response: { b: 2 }, statusCode: 200 }, 60)
    expect((await store.get('key-a'))?.response).toEqual({ a: 1 })
    expect((await store.get('key-b'))?.response).toEqual({ b: 2 })
  })
})

// ─── acquire() ───────────────────────────────────────────────────────────────

describe('acquire()', () => {
  it('returns true when key does not exist', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    expect(await store.acquire('new-key', 30)).toBe(true)
  })

  it('returns false when key already exists (processing)', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.acquire('locked-key', 30)
    expect(await store.acquire('locked-key', 30)).toBe(false)
  })

  it('returns false when key already has a completed record', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('completed-key', COMPLETED, 60)
    expect(await store.acquire('completed-key', 30)).toBe(false)
  })

  it('stores a processing record on success', async () => {
    const { client, db } = makeRedisStub()
    const store = new RedisStore(client)
    await store.acquire('proc-key', 30)
    expect(JSON.parse(db.get('idem:proc-key')!)).toEqual({ status: 'processing' })
  })

  it('passes the exact ttlSeconds to Redis EX', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.acquire('ttl-key', 90)
    expect(client.set).toHaveBeenCalledWith('idem:ttl-key', expect.any(String), 'NX', 'EX', 90)
  })

  it('issues SET NX — not a plain SET', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.acquire('nx-key', 30)
    expect(client.set.mock.calls[0]).toContain('NX')
  })

  it('independent keys each acquire successfully', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    expect(await store.acquire('key-x', 30)).toBe(true)
    expect(await store.acquire('key-y', 30)).toBe(true)
  })

  it('returns true after release() clears the processing lock', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.acquire('reacquire-key', 30)
    await store.release('reacquire-key')
    expect(await store.acquire('reacquire-key', 30)).toBe(true)
  })
})

// ─── get() ────────────────────────────────────────────────────────────────────

describe('get()', () => {
  it('returns null for a key that has never been set', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    expect(await store.get('missing-key')).toBeNull()
  })

  it('returns null while key is processing', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.acquire('in-flight', 30)
    expect(await store.get('in-flight')).toBeNull()
  })

  it('returns the completed record after set()', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('done-key', COMPLETED, 60)
    const result = await store.get('done-key')
    expect(result).toMatchObject({
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
    })
  })

  it('defaults statusCode to 200 when stored record omits it', async () => {
    const { client, db } = makeRedisStub()
    const store = new RedisStore(client)
    db.set('idem:no-sc', JSON.stringify({ status: 'completed', response: {} }))
    const result = await store.get('no-sc')
    expect(result?.statusCode).toBe(200)
  })

  it('returns null after the key is deleted', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('del-key', COMPLETED, 60)
    await store.delete('del-key')
    expect(await store.get('del-key')).toBeNull()
  })

  it('returns null for corrupted JSON', async () => {
    const { client } = makeRedisStub()
    client.get.mockResolvedValueOnce('not-valid-json}}}')
    const store = new RedisStore(client)
    expect(await store.get('corrupt-key')).toBeNull()
  })

  it('returns null for valid JSON with unexpected shape', async () => {
    const { client, db } = makeRedisStub()
    db.set('idem:bad-shape', JSON.stringify({ foo: 'bar' }))
    const store = new RedisStore(client)
    expect(await store.get('bad-shape')).toBeNull()
  })
})

// ─── set() ────────────────────────────────────────────────────────────────────

describe('set()', () => {
  it('issues SET with EX when ttlSeconds is provided', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('ttl-key', COMPLETED, 3600)
    expect(client.set).toHaveBeenCalledWith('idem:ttl-key', expect.any(String), 'EX', 3600)
  })

  it('issues SET without EX when ttlSeconds is omitted', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('no-ttl-key', COMPLETED)
    expect(client.set).toHaveBeenCalledWith('idem:no-ttl-key', expect.any(String))
  })

  it('serialises status as "completed"', async () => {
    const { client, db } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('serial-key', COMPLETED, 60)
    expect(JSON.parse(db.get('idem:serial-key')!)).toMatchObject({ status: 'completed' })
  })

  it('serialises response payload correctly', async () => {
    const { client, db } = makeRedisStub()
    const store = new RedisStore(client)
    const payload = { id: 'ord_1', amount: 5000, currency: 'USD' }
    await store.set('payload-key', { status: 'completed', response: payload, statusCode: 201 }, 60)
    expect(JSON.parse(db.get('idem:payload-key')!).response).toEqual(payload)
  })

  it('serialises statusCode when provided', async () => {
    const { client, db } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('sc-key', { status: 'completed', response: {}, statusCode: 204 }, 60)
    expect(JSON.parse(db.get('idem:sc-key')!).statusCode).toBe(204)
  })

  it('omits statusCode from payload when not provided', async () => {
    const { client, db } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('no-sc-key', { status: 'completed', response: {} }, 60)
    expect(JSON.parse(db.get('idem:no-sc-key')!)).not.toHaveProperty('statusCode')
  })

  it('overwrites a processing lock with a completed record', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.acquire('overwrite-key', 30)
    await store.set('overwrite-key', COMPLETED, 60)
    expect((await store.get('overwrite-key'))?.status).toBe('completed')
  })

  it('blocks a subsequent acquire() for the same key', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('block-key', COMPLETED, 60)
    expect(await store.acquire('block-key', 30)).toBe(false)
  })

  it('preserves nested objects in the response', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    const nested = { order: { id: 1, items: [{ sku: 'abc', qty: 2 }] } }
    await store.set('nested-key', { status: 'completed', response: nested, statusCode: 200 }, 60)
    expect((await store.get('nested-key'))?.response).toEqual(nested)
  })
})

// ─── delete() ────────────────────────────────────────────────────────────────

describe('delete()', () => {
  it('removes a completed record', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('del-completed', COMPLETED, 60)
    await store.delete('del-completed')
    expect(await store.get('del-completed')).toBeNull()
  })

  it('removes a processing lock — subsequent acquire() succeeds', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.acquire('del-proc', 30)
    await store.delete('del-proc')
    expect(await store.acquire('del-proc', 30)).toBe(true)
  })

  it('is a no-op for a missing key — does not throw', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await expect(store.delete('ghost-key')).resolves.not.toThrow()
  })

  it('is idempotent — calling twice does not throw', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('double-del', COMPLETED, 60)
    await store.delete('double-del')
    await expect(store.delete('double-del')).resolves.not.toThrow()
  })
})

// ─── release() ───────────────────────────────────────────────────────────────

describe('release()', () => {
  it('deletes a processing lock', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.acquire('proc-key', 30)
    client.del.mockClear()
    await store.release('proc-key')
    expect(client.del).toHaveBeenCalledWith('idem:proc-key')
  })

  it('allows re-acquire after releasing', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.acquire('re-key', 30)
    await store.release('re-key')
    expect(await store.acquire('re-key', 30)).toBe(true)
  })

  it('does NOT delete a completed record', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('completed-key', COMPLETED, 60)
    client.del.mockClear()
    await store.release('completed-key')
    expect(client.del).not.toHaveBeenCalled()
  })

  it('completed record remains readable after release()', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('preserved-key', COMPLETED, 60)
    await store.release('preserved-key')
    expect((await store.get('preserved-key'))?.status).toBe('completed')
  })

  it('is a no-op for a missing key — does not throw', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await expect(store.release('ghost-key')).resolves.not.toThrow()
  })

  it('does not call del() for a missing key', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.release('ghost-key')
    expect(client.del).not.toHaveBeenCalled()
  })

  it('is idempotent — releasing twice does not throw', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.acquire('double-release', 30)
    await store.release('double-release')
    await expect(store.release('double-release')).resolves.not.toThrow()
  })

  it('does not call del() for corrupted JSON', async () => {
    const { client } = makeRedisStub()
    client.get.mockResolvedValueOnce('not-valid-json}}}')
    const store = new RedisStore(client)
    await store.release('corrupt-key')
    expect(client.del).not.toHaveBeenCalled()
  })
})

// ─── Corrupted data handling ──────────────────────────────────────────────────

describe('corrupted data in Redis', () => {
  it('get() returns null for invalid JSON', async () => {
    const { client } = makeRedisStub()
    client.get.mockResolvedValueOnce('{invalid')
    const store = new RedisStore(client)
    expect(await store.get('corrupt-key')).toBeNull()
  })

  it('get() returns null for JSON with wrong shape', async () => {
    const { client, db } = makeRedisStub()
    db.set('idem:bad-shape', JSON.stringify({ foo: 'bar' }))
    const store = new RedisStore(client)
    expect(await store.get('bad-shape')).toBeNull()
  })

  it('release() does not throw for invalid JSON', async () => {
    const { client } = makeRedisStub()
    client.get.mockResolvedValueOnce('{invalid')
    const store = new RedisStore(client)
    await expect(store.release('corrupt-key')).resolves.not.toThrow()
  })

  it('release() does not call del() for invalid JSON', async () => {
    const { client } = makeRedisStub()
    client.get.mockResolvedValueOnce('{invalid')
    const store = new RedisStore(client)
    await store.release('corrupt-key')
    expect(client.del).not.toHaveBeenCalled()
  })
})

// ─── Key isolation ────────────────────────────────────────────────────────────

describe('key isolation', () => {
  it('different keys do not interfere with each other', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('key-x', { status: 'completed', response: { x: 1 }, statusCode: 200 }, 60)
    await store.set('key-y', { status: 'completed', response: { y: 2 }, statusCode: 200 }, 60)
    expect((await store.get('key-x'))?.response).toEqual({ x: 1 })
    expect((await store.get('key-y'))?.response).toEqual({ y: 2 })
  })

  it('releasing one key does not affect another', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.acquire('iso-a', 30)
    await store.acquire('iso-b', 30)
    await store.release('iso-a')
    expect(await store.acquire('iso-b', 30)).toBe(false)
  })

  it('deleting one key does not affect another', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('del-a', COMPLETED, 60)
    await store.set('del-b', COMPLETED, 60)
    await store.delete('del-a')
    expect(await store.get('del-b')).not.toBeNull()
  })
})

// ─── Fingerprint storage and retrieval ───────────────────────────────────────

describe('fingerprint — storage and retrieval', () => {
  it('serialises fingerprint into the stored payload', async () => {
    const { client, db } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set(
      'fp-key',
      { status: 'completed', response: {}, statusCode: 200, fingerprint: 'POST' },
      60,
    )
    expect(JSON.parse(db.get('idem:fp-key')!)).toMatchObject({ fingerprint: 'POST' })
  })

  it('returns fingerprint from get() after set()', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set(
      'fp-key',
      { status: 'completed', response: {}, statusCode: 200, fingerprint: 'POST' },
      60,
    )
    const result = await store.get('fp-key')
    expect(result?.fingerprint).toBe('POST')
  })

  it('returns SHA-256 fingerprint for method+path strategy', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    const fingerprint = 'a3f8c2d1e4b7f9c0d2e5f8a1b4c7d0e3f6a9b2c5'
    await store.set(
      'fp-path-key',
      { status: 'completed', response: {}, statusCode: 200, fingerprint },
      60,
    )
    const result = await store.get('fp-path-key')
    expect(result?.fingerprint).toBe(fingerprint)
  })

  it('omits fingerprint from payload when not provided', async () => {
    const { client, db } = makeRedisStub()
    const store = new RedisStore(client)
    await store.set('no-fp-key', { status: 'completed', response: {}, statusCode: 200 }, 60)
    expect(JSON.parse(db.get('idem:no-fp-key')!)).not.toHaveProperty('fingerprint')
  })

  it('returns undefined fingerprint when record has none — v0.1.x backward compat', async () => {
    const { client, db } = makeRedisStub()
    const store = new RedisStore(client)
    // Simulate a record written by v0.1.x — no fingerprint field
    db.set('idem:old-key', JSON.stringify({ status: 'completed', response: {}, statusCode: 200 }))
    const result = await store.get('old-key')
    expect(result?.fingerprint).toBeUndefined()
  })

  it('does not set fingerprint to empty string — undefined is correct sentinel', async () => {
    const { client, db } = makeRedisStub()
    const store = new RedisStore(client)
    db.set('idem:old-key', JSON.stringify({ status: 'completed', response: {}, statusCode: 200 }))
    const result = await store.get('old-key')
    expect(result?.fingerprint).not.toBe('')
  })

  it('fingerprint survives a full acquire → set → get cycle', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)
    const fingerprint = 'POST'

    await store.acquire('cycle-key', 30)
    await store.set(
      'cycle-key',
      { status: 'completed', response: { id: 'order_1' }, statusCode: 201, fingerprint },
      3600,
    )
    const result = await store.get('cycle-key')

    expect(result?.fingerprint).toBe(fingerprint)
    expect(result?.response).toEqual({ id: 'order_1' })
    expect(result?.statusCode).toBe(201)
  })

  it('different fingerprints stored on different keys do not collide', async () => {
    const { client } = makeRedisStub()
    const store = new RedisStore(client)

    await store.set(
      'key-a',
      { status: 'completed', response: {}, statusCode: 200, fingerprint: 'GET' },
      60,
    )
    await store.set(
      'key-b',
      { status: 'completed', response: {}, statusCode: 200, fingerprint: 'POST' },
      60,
    )

    expect((await store.get('key-a'))?.fingerprint).toBe('GET')
    expect((await store.get('key-b'))?.fingerprint).toBe('POST')
  })
})
