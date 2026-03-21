/**
 * Supported web frameworks for the reliability middleware.
 *
 * Passed as the `framework` field in ReliabilityOptions to tell the
 * library which adapter to use for bridging the framework's req/res
 * model to the engine's RequestContext.
 *
 * Each enum value maps to a dedicated adapter internally:
 *   Framework.EXPRESS  → expressAdapter()  (implemented)
 *   Framework.FASTIFY  → fastifyAdapter()  (planned)
 *   Framework.HONO     → honoAdapter()     (planned)
 *  Framework.KOA      → koaAdapter()      (planned)
 *  Framework.NEXTJS   → nextjsAdapter()   (planned)
 *
 * The value is a lowercase string rather than a number so that error
 * messages and logs are human-readable — if an unsupported framework
 * is passed, the error message includes the actual string value rather
 * than an opaque integer.
 *
 * @example
 * ```typescript
 * app.use(reliability({
 *   framework: Framework.EXPRESS,
 *   idempotency: { enabled: true, store }
 * }))
 * ```
 */
export enum Framework {
  /**
   * Express.js 4.x and above.
   * Fully implemented — production ready.
   */
  EXPRESS = 'express',

  /**
   * Fastify 4.x and above.
   * Planned — not yet implemented. Passing this value will throw
   * an 'Unsupported framework' error at setup time.
   */
  FASTIFY = 'fastify',

  /**
   * Hono — works across Node.js, Cloudflare Workers, Bun, and Deno.
   * Planned — not yet implemented. Passing this value will throw
   * an 'Unsupported framework' error at setup time.
   */
  HONO = 'hono',

  /**
   * Koa 2.x and above.
   * Planned — not yet implemented. Passing this value will throw
   * an 'Unsupported framework' error at setup time.
   */
  KOA = 'koa',

  /**
   * Next.js App Router and Pages Router API routes.
   * Planned — requires a wrapper function pattern rather than middleware.
   * Passing this value will throw an 'Unsupported framework' error at setup time.
   */
  NEXTJS = 'nextjs',
}