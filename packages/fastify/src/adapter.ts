import type { FastifyRequest, FastifyReply } from 'fastify'
import type { ReliabilityEngine, RequestContext } from '@reliability-tools/core'

/**
 * Fastify route handler type — matches Fastify's expected handler signature.
 */
type FastifyHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>

/**
 * Fastify adapter for the reliability engine.
 *
 * Unlike the Express adapter which uses middleware, the Fastify adapter
 * returns a wrapper function that decorates individual route handlers.
 * This avoids Fastify's plugin encapsulation rules entirely — no hooks,
 * no register(), no fastify-plugin dependency needed.
 *
 * The wrapper pattern is more explicit and flexible than hooks:
 *   - Applied per-route — only routes you wrap get idempotency
 *   - Works anywhere — no scoping or registration order to think about
 *   - Visible at the call site — developers can see which routes are protected
 *   - Composable — can be layered with other wrappers
 *
 * Called internally by reliability() — not intended for direct use.
 *
 * @example
 * ```typescript
 * const protect = reliability({ framework: Framework.FASTIFY, ... })
 *
 * fastify.post('/orders',   protect(createOrderHandler))
 * fastify.post('/payments', protect(createPaymentHandler))
 * fastify.get('/health',    healthHandler)  // ← not wrapped, no idempotency
 * ```
 */
export function fastifyAdapter(engine: ReliabilityEngine) {
  /**
   * The wrapper function — decorates a Fastify route handler with
   * reliability behaviour. Returns a new handler with the same signature
   * that Fastify expects.
   *
   * @param handler — the original route handler to wrap.
   * @returns a new handler that runs reliability modules before and after
   *          the original handler.
   */
  return function protect(handler: FastifyHandler): FastifyHandler {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      // Build a framework-agnostic context from the Fastify request.
      // Modules read from and write to ctx — they never touch Fastify's
      // request/reply directly, which keeps them portable across frameworks.
      const ctx: RequestContext = {
        method: request.method,
        path: request.url,
        headers: request.headers as Record<string, string | string[] | undefined>,
        body: request.body as unknown,
      }

      // ── Engine execution ───────────────────────────────────────────────
      //
      // Run all modules in sequence. next() executes the original handler
      // inline — unlike Express where next() hands off to the framework,
      // here we call the handler directly and capture its response.
      //
      // If a module short-circuits (e.g. idempotency cache hit), next() is
      // never called and the handler never runs. ctx.response is set by the
      // module instead and flushed to Fastify below.
      await engine.handle(ctx, async () => {
        // ── Execute the original handler ─────────────────────────────────
        //
        // Run the handler and intercept reply.send() to capture the response
        // into ctx so modules like idempotency can store it for future
        // duplicate requests.
        //
        // We patch reply.send() before calling the handler — the same
        // interception pattern as the Express adapter, applied here at the
        // route level rather than the middleware level.
        const originalSend = reply.send.bind(reply)

        reply.send = (payload?: unknown) => {
          ctx.response = payload
          ctx.statusCode = reply.statusCode
          return originalSend(payload)
        }

        await handler(request, reply)
      })

      // ── Intercepted response ───────────────────────────────────────────
      //
      // If a module wrote to ctx.response without calling next() — for
      // example, idempotency returning a cached response or a 409 — the
      // original handler never ran and Fastify hasn't sent anything yet.
      // Flush ctx.response to the client directly.
      //
      // If the handler ran normally, reply.sent is already true and this
      // block is skipped.
      if (ctx.response !== undefined && !reply.sent) {
        for (const [key, value] of Object.entries(ctx.responseHeaders ?? {}) as Array<
          [string, string]
        >) {
          reply.header(key, value)
        }

        await reply.status(ctx.statusCode ?? 200).send(ctx.response)
      }
    }
  }
}
