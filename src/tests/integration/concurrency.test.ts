import { IdempotencyModule } from '../../modules/idempotency/idempotency'
import { MemoryStore } from '../../modules/idempotency/stores/memory-store'
import { RequestContext } from '../../core/context'
import { describe, it, expect } from '@jest/globals'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(key = 'concurrent-key'): RequestContext {
  return {
    method: 'POST',
    path: '/orders',
    headers: { 'idempotency-key': key },
    body: {},
  }
}

/**
 * No-op handler — used when the test only cares about the module's
 * response (409, cached, etc.) and not what the handler does.
 */
const noopHandler = async () => {}

/**
 * Yields control back to the event loop once.
 * Lets other queued async operations run before continuing —
 * used to simulate interleaving between concurrent requests
 * without introducing real wall-clock delay.
 */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Real millisecond sleep — used to simulate handlers with actual latency
 * so a second request genuinely arrives while the first is mid-execution.
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Fires `count` concurrent executions of the same idempotency key.
 * Uses Promise.allSettled so one rejection doesn't short-circuit the rest.
 * Returns all contexts after every promise has settled.
 */
async function fireConcurrent(
  module: IdempotencyModule,
  count: number,
  key: string,
  handler: (ctx: RequestContext) => Promise<void>,
): Promise<RequestContext[]> {
  const contexts = Array.from({ length: count }, () => makeCtx(key))

  await Promise.allSettled(contexts.map((ctx) => module.execute(ctx, () => handler(ctx))))

  return contexts
}

// ─── Simultaneous acquire ─────────────────────────────────────────────────────

describe('simultaneous acquire', () => {
  /**
   * Core guarantee: exactly one request wins the lock.
   * Run multiple times to surface non-deterministic failures
   * that only appear under specific scheduling orders.
   */
  it('exactly one request wins when N fire simultaneously — repeated 5 times', async () => {
    const CONCURRENCY = 10

    for (let run = 0; run < 5; run++) {
      const store = new MemoryStore()
      const module = new IdempotencyModule({ store })
      let executionCount = 0

      const contexts = await fireConcurrent(module, CONCURRENCY, `race-key-${run}`, async (ctx) => {
        executionCount++
        await tick() // yield mid-handler to maximise interleaving opportunity
        ctx.response = { id: 'order_1' }
        ctx.statusCode = 201
      })

      const winners = contexts.filter((c) => c.statusCode === 201)
      const conflicts = contexts.filter((c) => c.statusCode === 409)

      if (executionCount !== 1) {
        throw new Error(`Run ${run}: expected executionCount to be 1, got ${executionCount}`)
      }

      expect(winners).toHaveLength(1)
      expect(conflicts).toHaveLength(CONCURRENCY - 1)
    }
  })

  it('winning response is complete — not a partial write', async () => {
    const store = new MemoryStore()
    const module = new IdempotencyModule({ store })

    const contexts = await fireConcurrent(module, 5, 'winner-check', async (ctx) => {
      await tick()
      ctx.response = { id: 'order_abc', status: 'created' }
      ctx.statusCode = 201
    })

    const winner = contexts.find((c) => c.statusCode === 201)
    expect(winner?.response).toEqual({ id: 'order_abc', status: 'created' })
  })

  it('all 409 responses carry Retry-After header and retryAfter body', async () => {
    const store = new MemoryStore()
    const module = new IdempotencyModule({ store, processingTtl: 30 })

    const contexts = await fireConcurrent(module, 5, 'retry-after-check', async (ctx) => {
      ctx.response = {}
      ctx.statusCode = 200
    })

    const conflicts = contexts.filter((c) => c.statusCode === 409)
    expect(conflicts.length).toBeGreaterThan(0)

    conflicts.forEach((ctx) => {
      expect(ctx.headers?.['Retry-After']).toBe('30')
      expect(ctx.response).toMatchObject({ retryAfter: 30 })
    })
  })
})

// ─── Slow handler — in-progress detection ────────────────────────────────────

describe('slow handler', () => {
  /**
   * A request arriving mid-execution must get 409 — not bypass the lock
   * or get served a partial response.
   */
  it('second request gets 409 while first handler is still executing', async () => {
    const store = new MemoryStore()
    const module = new IdempotencyModule({ store, processingTtl: 30 })

    const ctxA = makeCtx('slow-key')
    const ctxB = makeCtx('slow-key')

    // Start first request — real latency so ctxB genuinely arrives mid-execution
    const firstRequest = module.execute(ctxA, async () => {
      await sleep(50)
      ctxA.response = { id: 'order_1' }
      ctxA.statusCode = 201
    })

    // Yield enough for acquire() to have completed before ctxB fires
    await tick()
    await tick()

    await module.execute(ctxB, noopHandler)

    expect(ctxB.statusCode).toBe(409)
    expect(ctxB.response).toMatchObject({ error: 'Request already in progress' })
    expect(ctxB.headers?.['Retry-After']).toBeDefined()

    await firstRequest
  })

  it('request arriving after slow handler completes gets cached response', async () => {
    const store = new MemoryStore()
    const module = new IdempotencyModule({ store })
    let callCount = 0

    const ctxA = makeCtx('after-slow')
    await module.execute(ctxA, async () => {
      await sleep(20)
      callCount++
      ctxA.response = { id: 'order_1' }
      ctxA.statusCode = 201
    })

    const ctxB = makeCtx('after-slow')
    await module.execute(ctxB, async () => {
      callCount++
    })

    expect(callCount).toBe(1)
    expect(ctxB.response).toEqual({ id: 'order_1' })
    expect(ctxB.statusCode).toBe(201)
  })
})

// ─── Retry after failure ──────────────────────────────────────────────────────

describe('retry after failure', () => {
  /**
   * When the handler throws, the lock must be released immediately —
   * not after processingTtl expires. A retry must re-acquire within
   * the same test without any artificial wait.
   */
  it('retry re-executes immediately — no wait for processingTtl', async () => {
    const store = new MemoryStore()
    // Deliberately long processingTtl — if lock is not released, retry would
    // get a 409 instead of executing. Proves release() was called on failure.
    const module = new IdempotencyModule({ store, processingTtl: 9999 })
    let callCount = 0

    const ctxA = makeCtx('retry-key')
    await expect(
      module.execute(ctxA, async () => {
        callCount++
        throw new Error('transient failure')
      }),
    ).rejects.toThrow('transient failure')

    const ctxB = makeCtx('retry-key')
    await module.execute(ctxB, async () => {
      callCount++
      ctxB.response = { id: 'order_1' }
      ctxB.statusCode = 201
    })

    expect(callCount).toBe(2)
    expect(ctxB.statusCode).toBe(201)
  })

  it('only one of N concurrent retries wins after failure', async () => {
    const store = new MemoryStore()
    const module = new IdempotencyModule({ store })
    let callCount = 0

    // First attempt fails
    const ctxFail = makeCtx('concurrent-retry')
    await expect(
      module.execute(ctxFail, async () => {
        callCount++
        throw new Error('first attempt failed')
      }),
    ).rejects.toThrow()

    // Three concurrent retries — only one should win the re-acquired lock
    const retries = await fireConcurrent(module, 3, 'concurrent-retry', async (ctx) => {
      callCount++
      await tick()
      ctx.response = { id: 'order_1' }
      ctx.statusCode = 201
    })

    const winners = retries.filter((c) => c.statusCode === 201)
    const conflicts = retries.filter((c) => c.statusCode === 409)

    expect(winners).toHaveLength(1)
    expect(conflicts).toHaveLength(2)
    expect(callCount).toBe(2) // 1 failed + 1 successful retry
  })

  it('completed response is cached after successful retry', async () => {
    const store = new MemoryStore()
    const module = new IdempotencyModule({ store })

    // Fail once
    const ctxFail = makeCtx('retry-cache-key')
    await expect(
      module.execute(ctxFail, async () => {
        throw new Error('fail')
      }),
    ).rejects.toThrow()

    // Succeed on retry
    const ctxRetry = makeCtx('retry-cache-key')
    await module.execute(ctxRetry, async () => {
      ctxRetry.response = { id: 'order_1' }
      ctxRetry.statusCode = 201
    })

    // Subsequent duplicate gets cached response without executing handler
    const ctxDuplicate = makeCtx('retry-cache-key')
    await module.execute(ctxDuplicate, async () => {
      throw new Error('should not execute')
    })

    expect(ctxDuplicate.response).toEqual({ id: 'order_1' })
    expect(ctxDuplicate.statusCode).toBe(201)
  })
})

// ─── Key isolation under load ─────────────────────────────────────────────────

describe('key isolation', () => {
  it('concurrent requests with different keys all execute independently', async () => {
    const store = new MemoryStore()
    const module = new IdempotencyModule({ store })
    const results: Record<string, number> = {}

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const ctx = makeCtx(`unique-key-${i}`)
        return module.execute(ctx, async () => {
          await tick()
          results[`unique-key-${i}`] = i
          ctx.response = { i }
          ctx.statusCode = 200
        })
      }),
    )

    expect(Object.keys(results)).toHaveLength(10)
    Array.from({ length: 10 }, (_, i) => {
      expect(results[`unique-key-${i}`]).toBe(i)
    })
  })

  /**
   * 5 keys × 10 requests each = 50 total concurrent requests shuffled
   * to maximise cross-key interleaving. Each key must execute exactly once.
   */
  it('50 shuffled requests across 5 keys — each key executes exactly once', async () => {
    const store = new MemoryStore()
    const module = new IdempotencyModule({ store })
    const executionCounts: Record<string, number> = {}
    const KEYS = 5
    const REQUESTS_PER_KEY = 10

    const allRequests = Array.from({ length: KEYS }, (_, keyIndex) =>
      Array.from({ length: REQUESTS_PER_KEY }, () => {
        const key = `load-key-${keyIndex}`
        const ctx = makeCtx(key)
        return module.execute(ctx, async () => {
          executionCounts[key] = (executionCounts[key] ?? 0) + 1
          await tick()
          ctx.response = { key }
          ctx.statusCode = 200
        })
      }),
    ).flat()

    // Shuffle to maximise interleaving across keys
    allRequests.sort(() => Math.random() - 0.5)
    await Promise.allSettled(allRequests)

    expect(Object.keys(executionCounts)).toHaveLength(KEYS)
    Object.entries(executionCounts).forEach(([, count]) => {
      expect(count).toBe(1)
    })
  })
})

// ─── Never double-execute — stress test ──────────────────────────────────────

describe('no double execution — stress test', () => {
  /**
   * The hardest property to guarantee. Runs many times with varied yield
   * patterns to expose scheduling-dependent bugs. If executionCount ever
   * exceeds 1 for any key, the idempotency guarantee is broken.
   */
  it('handler never executes twice across 20 runs with varied yield patterns', async () => {
    const RUNS = 20
    const CONCURRENCY = 8

    for (let run = 0; run < RUNS; run++) {
      const store = new MemoryStore()
      const module = new IdempotencyModule({ store })
      let executionCount = 0
      const key = `stress-${run}`

      await Promise.allSettled(
        Array.from({ length: CONCURRENCY }, () => {
          const ctx = makeCtx(key)
          return module.execute(ctx, async () => {
            executionCount++
            // Vary yield points per run to expose different interleaving patterns
            if (run % 2 === 0) await tick()
            if (run % 3 === 0) await tick()
            if (run % 5 === 0) await sleep(1)
            ctx.response = { run }
            ctx.statusCode = 200
          })
        }),
      )

      if (executionCount !== 1) {
        throw new Error(`Run ${run}: expected executionCount to be 1, got ${executionCount}`)
      }
    }
  }, 15_000) // generous timeout for sleep() runs
})
