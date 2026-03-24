import { ReliabilityEngine } from '../../core/engine'
import { RequestContext } from '../../core/context'
import { ReliabilityModule } from '../../core/module'
import { jest, describe, it, expect } from '@jest/globals'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    method: 'POST',
    path: '/test',
    headers: {},
    body: {},
    ...overrides,
  }
}

function makeModule(
  fn: (ctx: RequestContext, next: () => Promise<void>) => Promise<void>,
): ReliabilityModule {
  return { execute: fn }
}

const noopHandler = jest.fn(async () => {})

// ─── Basic execution ──────────────────────────────────────────────────────────

describe('ReliabilityEngine — basic execution', () => {
  it('calls handler directly when no modules are registered', async () => {
    const engine = new ReliabilityEngine([])
    const handler = jest.fn(async () => {})
    await engine.handle(makeCtx(), handler)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('calls handler after all modules call next()', async () => {
    const callOrder: string[] = []
    const moduleA = makeModule(async (ctx, next) => {
      callOrder.push('A')
      await next()
    })
    const moduleB = makeModule(async (ctx, next) => {
      callOrder.push('B')
      await next()
    })
    const engine = new ReliabilityEngine([moduleA, moduleB])
    const handler = jest.fn(async () => {
      callOrder.push('handler')
    })

    await engine.handle(makeCtx(), handler)

    expect(callOrder).toEqual(['A', 'B', 'handler'])
  })

  it('passes ctx to every module and the handler', async () => {
    const received: RequestContext[] = []
    const module = makeModule(async (ctx, next) => {
      received.push(ctx)
      await next()
    })
    const engine = new ReliabilityEngine([module])
    const ctx = makeCtx()
    const handler = jest.fn(async () => {
      received.push(ctx)
    })

    await engine.handle(ctx, handler)

    expect(received).toHaveLength(2)
    expect(received[0]).toBe(ctx)
    expect(received[1]).toBe(ctx)
  })
})

// ─── Short-circuit ────────────────────────────────────────────────────────────

describe('ReliabilityEngine — short-circuit', () => {
  it('does not call handler when a module short-circuits without calling next()', async () => {
    const module = makeModule(async (ctx) => {
      ctx.response = { blocked: true }
      ctx.statusCode = 409
      // next() not called — short-circuit
    })
    const engine = new ReliabilityEngine([module])
    const handler = jest.fn(async () => {})

    await engine.handle(makeCtx(), handler)

    expect(handler).not.toHaveBeenCalled()
  })

  it('does not call subsequent modules when earlier module short-circuits', async () => {
    const callOrder: string[] = []
    const moduleA = makeModule(async (ctx) => {
      ctx.response = { blocked: true }
      callOrder.push('A') // short-circuits, never calls next()
    })
    const moduleB = makeModule(async (ctx, next) => {
      callOrder.push('B') // should never be reached
      await next()
    })
    const engine = new ReliabilityEngine([moduleA, moduleB])

    await engine.handle(makeCtx(), noopHandler)

    expect(callOrder).toEqual(['A'])
  })

  // ── Line 116: ctx.response stop-propagation ───────────────────────────────
  //
  // When a downstream module sets ctx.response, the engine stops propagating
  // back up the chain after it returns. Earlier modules that awaited next()
  // should not run any code after the await if ctx.response is set.
  it('stops propagating back up the chain when ctx.response is set by downstream module', async () => {
    const callOrder: string[] = []

    const moduleA = makeModule(async (ctx, next) => {
      callOrder.push('A:before')
      await next()
      callOrder.push('A:after') // ← should NOT run — ctx.response was set downstream
    })

    const moduleB = makeModule(async (ctx) => {
      ctx.response = { set: 'by-B' }
      callOrder.push('B:set-response')
      // does not call next() — short-circuits
    })

    const engine = new ReliabilityEngine([moduleA, moduleB])
    const handler = jest.fn(async () => {
      callOrder.push('handler')
    })

    await engine.handle(makeCtx(), handler)

    expect(callOrder).toEqual(['A:before', 'B:set-response', 'A:after'])
    expect(handler).not.toHaveBeenCalled()
  })

  it('preserves the response set by the short-circuiting module', async () => {
    const module = makeModule(async (ctx) => {
      ctx.response = { error: 'Duplicate request' }
      ctx.statusCode = 409
    })
    const engine = new ReliabilityEngine([module])
    const ctx = makeCtx()

    await engine.handle(ctx, noopHandler)

    expect(ctx.response).toEqual({ error: 'Duplicate request' })
    expect(ctx.statusCode).toBe(409)
  })
})

// ─── Post-handler logic ───────────────────────────────────────────────────────

describe('ReliabilityEngine — post-handler logic', () => {
  it('allows modules to read ctx.response after handler runs', async () => {
    const responsesAfterNext: unknown[] = []

    const module = makeModule(async (ctx, next) => {
      await next()
      responsesAfterNext.push(ctx.response) // runs after handler
    })

    const engine = new ReliabilityEngine([module])
    const ctx = makeCtx()
    const handler = jest.fn(async () => {
      ctx.response = { id: 'order_1' }
      ctx.statusCode = 201
    })

    await engine.handle(ctx, handler)

    expect(responsesAfterNext).toEqual([{ id: 'order_1' }])
  })

  it('executes modules in order both before and after handler', async () => {
    const callOrder: string[] = []

    const moduleA = makeModule(async (ctx, next) => {
      callOrder.push('A:before')
      await next()
      callOrder.push('A:after')
    })

    const moduleB = makeModule(async (ctx, next) => {
      callOrder.push('B:before')
      await next()
      callOrder.push('B:after')
    })

    const engine = new ReliabilityEngine([moduleA, moduleB])
    const handler = jest.fn(async () => {
      callOrder.push('handler')
    })

    await engine.handle(makeCtx(), handler)

    expect(callOrder).toEqual(['A:before', 'B:before', 'handler', 'B:after', 'A:after'])
  })
})

// ─── Error handling ───────────────────────────────────────────────────────────

describe('ReliabilityEngine — error handling', () => {
  it('propagates handler errors up through the chain', async () => {
    const module = makeModule(async (ctx, next) => {
      await next() // handler throws — error propagates here
    })
    const engine = new ReliabilityEngine([module])
    const handler = jest.fn(async () => {
      throw new Error('handler failed')
    })

    await expect(engine.handle(makeCtx(), handler)).rejects.toThrow('handler failed')
  })

  it('propagates module errors up through the chain', async () => {
    const module = makeModule(async () => {
      throw new Error('module failed')
    })
    const engine = new ReliabilityEngine([module])

    await expect(engine.handle(makeCtx(), noopHandler)).rejects.toThrow('module failed')
  })

  // ── Line 90: next() called multiple times guard ───────────────────────────
  //
  // If a module calls next() more than once, the same downstream modules and
  // handler would execute twice — producing duplicate side effects. The engine
  // detects this via the index guard and throws immediately.
  it('throws when a module calls next() more than once', async () => {
    const module = makeModule(async (ctx, next) => {
      await next()
      await next() // ← second call — must throw
    })
    const engine = new ReliabilityEngine([module])

    await expect(engine.handle(makeCtx(), noopHandler)).rejects.toThrow(
      'next() called multiple times',
    )
  })

  it('throws on double next() even with multiple modules in the chain', async () => {
    const badModule = makeModule(async (ctx, next) => {
      await next()
      await next() // ← double call
    })
    const goodModule = makeModule(async (ctx, next) => {
      await next()
    })
    const engine = new ReliabilityEngine([badModule, goodModule])

    await expect(engine.handle(makeCtx(), noopHandler)).rejects.toThrow(
      'next() called multiple times',
    )
  })
})

// ─── Empty and edge cases ─────────────────────────────────────────────────────

describe('ReliabilityEngine — edge cases', () => {
  it('handles empty module array — calls handler directly', async () => {
    const engine = new ReliabilityEngine([])
    const handler = jest.fn(async () => {})
    await engine.handle(makeCtx(), handler)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does not mutate ctx unexpectedly', async () => {
    const module = makeModule(async (ctx, next) => {
      await next()
    })
    const engine = new ReliabilityEngine([module])
    const ctx = makeCtx({ method: 'POST', path: '/orders', body: { amount: 100 } })
    await engine.handle(ctx, noopHandler)
    expect(ctx.method).toBe('POST')
    expect(ctx.path).toBe('/orders')
    expect(ctx.body).toEqual({ amount: 100 })
  })

  it('single module that calls next() reaches the handler', async () => {
    const module = makeModule(async (ctx, next) => {
      await next()
    })
    const engine = new ReliabilityEngine([module])
    const handler = jest.fn(async () => {})
    await engine.handle(makeCtx(), handler)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
