import { ReliabilityEngine } from '../core/engine'
import { RequestContext } from '../core/context'
import { IdempotencyModule } from '../modules/idempotency/idempotency'
import { ReliabilityOptions } from '../types/options'
import type { Request, Response, NextFunction, RequestHandler } from 'express'

/**
 * Express middleware adapter for the reliability engine.
 *
 * Bridges Express's req/res/next model to the engine's framework-agnostic
 * RequestContext. All reliability modules (idempotency, logging, etc.)
 * operate against RequestContext — they never touch Express objects directly.
 * This is what allows the same module logic to work across different frameworks.
 *
 * The adapter handles two distinct execution flows:
 *
 * Normal flow — no module short-circuits. The handler runs, writes its
 *   response via res.send/json/end, and Express sends it normally.
 *   The adapter's response interception captures the response into ctx
 *   for modules like logging and idempotency to read after the fact.
 *
 * Intercepted flow — a module writes to ctx.response without calling
 *   next() (e.g. idempotency cache hit, 409 in-progress). The handler
 *   never runs. The adapter detects this via headersSent and flushes
 *   ctx.response to the client directly.
 *
 * Called internally by reliability() — not intended for direct use.
 * Users should call reliability({ framework: Framework.EXPRESS, ... }).
 */
export function expressAdapter(options: ReliabilityOptions): RequestHandler {
  // Construct modules once per middleware registration — not per request.
  // Module instances are stateless with respect to individual requests
  // (all state lives in the store or ctx), so sharing them across requests
  // is safe and avoids unnecessary allocations on every request.
  const modules = []

  // Idempotency is opt-in — only constructed when explicitly enabled.
  // Keeping it opt-in means the adapter adds zero overhead for apps
  // that don't need idempotency.
  if (options.idempotency?.enabled) {
    modules.push(new IdempotencyModule(options.idempotency))
  }

  const engine = new ReliabilityEngine(modules)

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // ── Build the framework-agnostic context ───────────────────────────
    //
    // Translate the Express request into a RequestContext that modules
    // can read from and write to without any knowledge of Express.
    // Modules set ctx.response and ctx.statusCode — the adapter is
    // responsible for flushing those back to Express at the end.
    const ctx: RequestContext = {
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: req.body as unknown,
      statusCode: 200,
    }

    // ── Response interception ──────────────────────────────────────────
    //
    // Express has no single "response committed" hook — a handler can
    // write a response via res.send(), res.json(), or res.end(). We patch
    // all three to capture the response body and status code into ctx
    // whenever the handler (or Express itself) writes a response.
    //
    // Why we need this:
    //   1. Idempotency needs the response body to store for future
    //      duplicate requests — without interception it has no way to
    //      read what the handler wrote after the fact.
    //   2. Logging needs the final response to record the outcome.
    //
    // The original methods are preserved and always called — interception
    // does not replace or suppress the response, it only observes it.
    // The handler's response still flows to the client normally.
    const originalSend = res.send.bind(res)
    const originalJson = res.json.bind(res)
    const originalEnd = res.end.bind(res)

    res.json = (body: unknown) => {
      ctx.response = body
      ctx.statusCode = res.statusCode
      return originalJson(body)
    }

    res.send = (body: unknown) => {
      ctx.response = body
      ctx.statusCode = res.statusCode
      return originalSend(body)
    }

    // res.end() is the lowest-level write method — underlying both send()
    // and json(). Patched as a catch-all for handlers that bypass the
    // higher-level methods and write to the stream directly (e.g. file
    // downloads, raw streams). Guards against overwriting a response
    // already captured by send() or json() since those call end() internally.
    res.end = (body?: unknown) => {
      if (body && ctx.response === undefined) {
        ctx.response = body
      }
      ctx.statusCode = res.statusCode
      return originalEnd(body)
    }

    // ── Engine execution ───────────────────────────────────────────────
    //
    // Hand off to the engine with the actual Express handler as next().
    // The engine runs all modules in sequence. Each module either calls
    // next() to continue the chain, or short-circuits by writing to ctx
    // and returning without calling next().
    //
    // The 'finish' event is awaited inside next() so that modules running
    // after the handler (e.g. idempotency's set(), logging) can read the
    // final ctx.response before the engine returns control here.
    // Without this await, the handler would be called but control would
    // return to the engine before Express had finished writing the response.
    await engine.handle(ctx, async () => {
      await new Promise<void>((resolve) => {
        res.on('finish', resolve)
        next()
      })
    })

    // ── Flush intercepted response ─────────────────────────────────────
    //
    // If a module wrote ctx.response without calling next() — for example,
    // idempotency returning a cached response or a 409 in-progress — the
    // Express handler never ran and no response has been sent yet.
    //
    // headersSent is the correct signal: if the handler ran normally,
    // Express has already sent the response and headersSent is true,
    // so this block is skipped. If a module short-circuited, headersSent
    // is false and we flush ctx.response to the client here.
    //
    // Using res.json() rather than res.send() ensures the correct
    // Content-Type header is set for object responses (application/json).
    if (ctx.response !== undefined && !res.headersSent) {
      res.status(ctx.statusCode as number).json(ctx.response)
    }
  }
}
