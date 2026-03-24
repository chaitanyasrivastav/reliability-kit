import { RequestContext } from './context'

/**
 * Contract that all reliability modules must satisfy.
 *
 * A reliability module is a single unit of cross-cutting behaviour that
 * wraps request execution — idempotency, logging, rate limiting, circuit
 * breaking, retries, etc. Modules are composable: the ReliabilityEngine
 * chains them sequentially, each receiving the shared context and a
 * next() function that advances to the next module in the chain.
 *
 * Modules follow the middleware pattern:
 *   - Call next() to continue the chain (pass-through or post-processing).
 *   - Return without calling next() to short-circuit (block or replace response).
 *   - Await next() to run logic both before and after the handler.
 *
 * @example Pass-through module (runs logic after the handler):
 * ```typescript
 * class LoggingModule implements ReliabilityModule {
 *   async execute(ctx: RequestContext, next: () => Promise<void>) {
 *     await next()                          // handler runs first
 *     console.log(ctx.method, ctx.statusCode) // then we log the outcome
 *   }
 * }
 * ```
 *
 * @example Short-circuit module (blocks the handler):
 * ```typescript
 * class MaintenanceModeModule implements ReliabilityModule {
 *   async execute(ctx: RequestContext, next: () => Promise<void>) {
 *     ctx.statusCode = 503
 *     ctx.response = { error: 'Service unavailable' }
 *     // next() is never called — handler is bypassed entirely
 *   }
 * }
 * ```
 *
 * @example Wrapping module (runs logic before and after the handler):
 * ```typescript
 * class TimingModule implements ReliabilityModule {
 *   async execute(ctx: RequestContext, next: () => Promise<void>) {
 *     const start = Date.now()
 *     await next()                              // handler runs in between
 *     console.log(`${ctx.path} took ${Date.now() - start}ms`)
 *   }
 * }
 * ```
 */
export interface ReliabilityModule {
  /**
   * Executes the module's logic for a single request.
   *
   * Implementations must adhere to these contracts:
   *
   * 1. Call next() at most once. Calling it more than once will throw
   *    an error from the engine — downstream modules and the handler
   *    would execute twice, producing duplicate side effects.
   *
   * 2. Propagate errors from next(). If next() throws, either rethrow
   *    the error or handle it deliberately. Silently swallowing errors
   *    from next() hides handler failures from the caller.
   *
   * 3. Do not write to ctx.response after calling next() unless
   *    intentionally overriding the handler's response. The engine
   *    stops propagating once ctx.response is set, but module code
   *    that runs after await next() can still mutate ctx.
   *
   * @param ctx  — shared request context. Read headers/body for input,
   *               write response/statusCode to produce output.
   * @param next — advances to the next module, or to the handler if
   *               this is the last module in the chain. Must be called
   *               at most once. Awaiting it runs the entire downstream
   *               chain before returning.
   */
  execute(ctx: RequestContext, next: () => Promise<void>): Promise<void>
}
