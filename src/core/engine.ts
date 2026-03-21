import { RequestContext } from './context'
import { ReliabilityModule } from './module'

/**
 * Core execution engine that runs reliability modules as a sequential
 * middleware chain before delegating to the actual request handler.
 *
 * Implements the chain-of-responsibility pattern — each module receives
 * the shared RequestContext and a next() function. Calling next() advances
 * to the next module in the chain. Not calling it short-circuits execution,
 * which is how modules like idempotency return a cached response or 409
 * without the request ever reaching the handler.
 *
 * Execution order (normal flow, no short-circuit):
 *   module[0] → module[1] → ... → module[n] → handler()
 *
 * Short-circuit flow (e.g. idempotency cache hit at module[1]):
 *   module[0] → module[1] → writes ctx.response, returns
 *                         ↳ module[2]..handler() never called
 *
 * The engine is framework-agnostic — it operates entirely on RequestContext
 * and has no knowledge of Express, Fastify, or any HTTP framework. The
 * framework adapter (e.g. expressAdapter) is responsible for translating
 * between the framework's req/res model and RequestContext before and
 * after calling engine.handle().
 *
 * Design note: this pattern is intentionally similar to Express/Koa
 * middleware chains. The key difference is that this engine operates on
 * a plain RequestContext object rather than framework-specific req/res,
 * keeping all reliability modules portable across frameworks.
 */
export class ReliabilityEngine {
  private modules: ReliabilityModule[]

  /**
   * @param modules — ordered list of reliability modules to run before
   *                  the handler. Executed left-to-right. An empty array
   *                  is valid — handle() will call the handler directly.
   */
  constructor(modules: ReliabilityModule[]) {
    this.modules = modules
  }

  /**
   * Runs the full module chain against the given context, then calls
   * the handler if no module short-circuited.
   *
   * Modules run in the order they were passed to the constructor. Each
   * module can either call next() to continue or return without calling
   * it to short-circuit. If all modules call next(), the handler runs.
   *
   * @param ctx     — shared request context. Modules read from it (headers,
   *                  body, method) and write to it (response, statusCode).
   *                  The last write wins — later modules can overwrite
   *                  ctx.response set by earlier ones, though the ctx.response
   *                  guard in dispatch() prevents most accidental overwrites.
   * @param handler — the actual request handler, called only after all
   *                  modules have passed through. In the Express adapter
   *                  this is the Express next() wrapped in a 'finish' promise.
   */
  async handle(ctx: RequestContext, handler: () => Promise<void>): Promise<void> {
    // Tracks the highest dispatch index called so far.
    // Used by the double-invocation guard in dispatch() — if a module
    // calls next() twice, i <= index catches it before the same module
    // runs a second time and corrupts the chain state.
    let index = -1

    /**
     * Recursive dispatcher — advances through the module array one step
     * at a time, passing each module a closure over dispatch(i + 1) as
     * its next() function.
     *
     * Recursion terminates in one of two ways:
     *   1. i exceeds the module array length → handler() is called.
     *   2. A module returns without calling next() → chain short-circuits.
     *
     * The index guard mirrors the pattern used in Express (router.handle)
     * and Koa (koa-compose) for the same reason — detecting double next()
     * calls catches bugs in module implementations before they corrupt
     * request state in ways that are hard to debug.
     *
     * @param i — index of the module to execute in this invocation.
     */
    const dispatch = async (i: number): Promise<void> => {
      // Guard against a module calling next() more than once.
      // Without this, a module with a bug like:
      //   await next(); await next();
      // would execute all downstream modules and the handler twice,
      // producing duplicate side effects and corrupting ctx state.
      if (i <= index) throw new Error('next() called multiple times')

      index = i
      const module = this.modules[i]

      // No module at index i — the chain is exhausted.
      // Hand off to the actual request handler.
      if (!module) {
        return handler()
      }

      // Execute the module, injecting dispatch(i + 1) as its next().
      // The module owns the decision: call next() to continue the chain,
      // or return without calling it to short-circuit. Either way,
      // execution resumes here once the module and everything it awaited
      // (including downstream modules and the handler) have settled.
      await module.execute(ctx, () => dispatch(i + 1))

      // After a module and its entire downstream chain complete, check
      // whether a response was written to ctx. If so, stop propagating
      // back up the call stack — earlier modules should not overwrite
      // a response that a later module or the handler already set.
      //
      // Example: module[0] calls next(), module[1] short-circuits with
      // a 409. Without this guard, execution would return to module[0]
      // which could accidentally overwrite the 409 with its own response.
      if (ctx.response !== undefined) {
        return
      }
    }

    await dispatch(0)
  }
}
