import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals'
import { MemoryStore } from '../../modules/idempotency/stores/memory-store'
import { IdempotencyRecord } from '../../modules/idempotency/stores/store'

beforeAll((): void => {
  jest.useFakeTimers()
})
afterAll((): void => {
  jest.useRealTimers()
})

const COMPLETED: IdempotencyRecord = {
  status: 'completed',
  response: { id: 'order_1' },
  statusCode: 201,
}

// ─── get() ────────────────────────────────────────────────────────────────────

describe('get()', () => {
  it('returns null for a key that has never been set', async () => {
    const store = new MemoryStore()
    expect(await store.get('missing-key')).toBeNull()
  })

  it('returns null while key is still processing', async () => {
    const store = new MemoryStore()
    await store.acquire('in-flight', 30)
    expect(await store.get('in-flight')).toBeNull()
  })

  it('returns the record after set() completes', async () => {
    const store = new MemoryStore()
    await store.set('done-key', COMPLETED, 60)
    const result = await store.get('done-key')
    expect(result).toMatchObject({
      status: 'completed',
      response: { id: 'order_1' },
      statusCode: 201,
    })
  })

  it('returns the exact value object passed to set()', async () => {
    const store = new MemoryStore()
    const payload = { id: 'ord_1', amount: 5000, currency: 'USD' }
    const record: IdempotencyRecord = { status: 'completed', response: payload, statusCode: 200 }
    await store.set('exact-key', record, 60)
    expect((await store.get('exact-key'))?.response).toEqual(payload)
  })

  it('returns null after the key is deleted', async () => {
    const store = new MemoryStore()
    await store.set('del-key', COMPLETED, 60)
    await store.delete('del-key')
    expect(await store.get('del-key')).toBeNull()
  })

  it('returns null after release() clears a processing lock', async () => {
    const store = new MemoryStore()
    await store.acquire('released-key', 30)
    await store.release('released-key')
    expect(await store.get('released-key')).toBeNull()
  })

  it('preserves nested objects in the response', async () => {
    const store = new MemoryStore()
    const nested = { order: { id: 1, items: [{ sku: 'abc', qty: 2 }] } }
    await store.set('nested-key', { status: 'completed', response: nested, statusCode: 200 }, 60)
    expect((await store.get('nested-key'))?.response).toEqual(nested)
  })

  it('returns record correctly when statusCode is undefined', async () => {
    const store = new MemoryStore()
    await store.set('no-sc-key', { status: 'completed', response: { ok: true } }, 60)
    const result = await store.get('no-sc-key')
    expect(result).not.toBeNull()
    expect(result?.response).toEqual({ ok: true })
  })
})

// ─── acquire() ───────────────────────────────────────────────────────────────

describe('acquire()', () => {
  it('returns true when key does not exist', async () => {
    const store = new MemoryStore()
    expect(await store.acquire('new-key', 30)).toBe(true)
  })

  it('returns false on second acquire for the same key', async () => {
    const store = new MemoryStore()
    await store.acquire('locked-key', 30)
    expect(await store.acquire('locked-key', 30)).toBe(false)
  })

  it('returns false when key already has a completed record', async () => {
    const store = new MemoryStore()
    await store.set('completed-key', COMPLETED, 60)
    expect(await store.acquire('completed-key', 30)).toBe(false)
  })

  it('returns true for different keys independently', async () => {
    const store = new MemoryStore()
    expect(await store.acquire('key-a', 30)).toBe(true)
    expect(await store.acquire('key-b', 30)).toBe(true)
  })

  it('returns true after release() clears a processing lock', async () => {
    const store = new MemoryStore()
    await store.acquire('re-acquire', 30)
    await store.release('re-acquire')
    expect(await store.acquire('re-acquire', 30)).toBe(true)
  })

  it('concurrent calls for the same key — only one wins', async () => {
    const store = new MemoryStore()
    const results = await Promise.all([
      store.acquire('concurrent-key', 30),
      store.acquire('concurrent-key', 30),
      store.acquire('concurrent-key', 30),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
  })
})

// ─── acquire() — TTL expiry ───────────────────────────────────────────────────

describe('acquire() — TTL expiry', () => {
  it('removes the processing lock after ttlSeconds', async () => {
    const store = new MemoryStore()
    await store.acquire('expiring-lock', 1)
    expect(await store.acquire('expiring-lock', 1)).toBe(false)

    jest.advanceTimersByTime(1001)

    expect(await store.acquire('expiring-lock', 1)).toBe(true)
  })

  it('does NOT wipe a completed record when processing TTL fires', async () => {
    const store = new MemoryStore()
    await store.acquire('race-key', 1)
    // handler completes before processingTtl fires
    await store.set('race-key', COMPLETED, 60)

    jest.advanceTimersByTime(1001)

    expect((await store.get('race-key'))?.status).toBe('completed')
  })

  it('persists indefinitely when no ttlSeconds is passed to set()', async () => {
    const store = new MemoryStore()
    await store.set('no-ttl-key', COMPLETED)

    jest.advanceTimersByTime(1000 * 60 * 60 * 24) // 24 hours

    expect(await store.get('no-ttl-key')).not.toBeNull()
  })

  it('removes a completed record after its ttlSeconds', async () => {
    const store = new MemoryStore()
    await store.set('short-ttl-key', COMPLETED, 1)
    expect(await store.get('short-ttl-key')).not.toBeNull()

    jest.advanceTimersByTime(1001)

    expect(await store.get('short-ttl-key')).toBeNull()
  })
})

// ─── set() ────────────────────────────────────────────────────────────────────

describe('set()', () => {
  it('overwrites a processing lock with a completed record', async () => {
    const store = new MemoryStore()
    await store.acquire('overwrite-key', 30)
    await store.set('overwrite-key', COMPLETED, 60)
    expect((await store.get('overwrite-key'))?.status).toBe('completed')
  })

  it('blocks a subsequent acquire() for the same key', async () => {
    const store = new MemoryStore()
    await store.set('block-key', COMPLETED, 60)
    expect(await store.acquire('block-key', 30)).toBe(false)
  })

  it('can be called without ttlSeconds — resolves without throwing', async () => {
    const store = new MemoryStore()
    await expect(store.set('no-ttl', COMPLETED)).resolves.not.toThrow()
    expect((await store.get('no-ttl'))?.status).toBe('completed')
  })

  it('preserves statusCode exactly', async () => {
    const store = new MemoryStore()
    await store.set('sc-key', { status: 'completed', response: {}, statusCode: 204 }, 60)
    expect((await store.get('sc-key'))?.statusCode).toBe(204)
  })

  it('calling set() twice for the same key overwrites the first', async () => {
    const store = new MemoryStore()
    await store.set(
      'overwrite-key',
      { status: 'completed', response: { v: 1 }, statusCode: 200 },
      60,
    )
    await store.set(
      'overwrite-key',
      { status: 'completed', response: { v: 2 }, statusCode: 200 },
      60,
    )
    expect((await store.get('overwrite-key'))?.response).toEqual({ v: 2 })
  })
})

// ─── delete() ────────────────────────────────────────────────────────────────

describe('delete()', () => {
  it('removes a completed record', async () => {
    const store = new MemoryStore()
    await store.set('del-completed', COMPLETED, 60)
    await store.delete('del-completed')
    expect(await store.get('del-completed')).toBeNull()
  })

  it('removes a processing lock — subsequent acquire() succeeds', async () => {
    const store = new MemoryStore()
    await store.acquire('del-proc', 30)
    await store.delete('del-proc')
    expect(await store.acquire('del-proc', 30)).toBe(true)
  })

  it('is a no-op for a missing key — does not throw', async () => {
    const store = new MemoryStore()
    await expect(store.delete('ghost-key')).resolves.not.toThrow()
  })

  it('is idempotent — calling twice does not throw', async () => {
    const store = new MemoryStore()
    await store.set('double-del', COMPLETED, 60)
    await store.delete('double-del')
    await expect(store.delete('double-del')).resolves.not.toThrow()
  })
})

// ─── release() ───────────────────────────────────────────────────────────────

describe('release()', () => {
  it('allows re-acquire after releasing a processing lock', async () => {
    const store = new MemoryStore()
    await store.acquire('release-key', 30)
    await store.release('release-key')
    expect(await store.acquire('release-key', 30)).toBe(true)
  })

  it('does NOT delete a completed record', async () => {
    const store = new MemoryStore()
    await store.set('completed-release', COMPLETED, 60)
    await store.release('completed-release')
    expect((await store.get('completed-release'))?.status).toBe('completed')
  })

  it('completed record remains readable after release()', async () => {
    const store = new MemoryStore()
    await store.set('preserved-key', COMPLETED, 60)
    await store.release('preserved-key')
    expect(await store.get('preserved-key')).not.toBeNull()
  })

  it('is a no-op for a missing key — does not throw', async () => {
    const store = new MemoryStore()
    await expect(store.release('ghost-key')).resolves.not.toThrow()
  })

  it('is idempotent — releasing twice does not throw', async () => {
    const store = new MemoryStore()
    await store.acquire('double-release', 30)
    await store.release('double-release')
    await expect(store.release('double-release')).resolves.not.toThrow()
  })

  it('second release is a no-op — key stays gone', async () => {
    const store = new MemoryStore()
    await store.acquire('double-release-check', 30)
    await store.release('double-release-check')
    await store.release('double-release-check')
    expect(await store.get('double-release-check')).toBeNull()
  })
})

// ─── Key isolation ────────────────────────────────────────────────────────────

describe('key isolation', () => {
  it('different keys do not interfere with each other', async () => {
    const store = new MemoryStore()
    await store.set('key-x', { status: 'completed', response: { x: 1 }, statusCode: 200 }, 60)
    await store.set('key-y', { status: 'completed', response: { y: 2 }, statusCode: 200 }, 60)
    expect((await store.get('key-x'))?.response).toEqual({ x: 1 })
    expect((await store.get('key-y'))?.response).toEqual({ y: 2 })
  })

  it('releasing one key does not affect another locked key', async () => {
    const store = new MemoryStore()
    await store.acquire('iso-a', 30)
    await store.acquire('iso-b', 30)
    await store.release('iso-a')
    expect(await store.acquire('iso-b', 30)).toBe(false)
  })

  it('deleting one key does not affect another', async () => {
    const store = new MemoryStore()
    await store.set('del-a', COMPLETED, 60)
    await store.set('del-b', COMPLETED, 60)
    await store.delete('del-a')
    expect(await store.get('del-b')).not.toBeNull()
  })

  it('completing one key does not unblock another locked key', async () => {
    const store = new MemoryStore()
    await store.acquire('lock-a', 30)
    await store.acquire('lock-b', 30)
    await store.set('lock-a', COMPLETED, 60)
    expect(await store.acquire('lock-b', 30)).toBe(false)
  })
})
