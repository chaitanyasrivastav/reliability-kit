import { Framework } from '../types/framework'
import { ReliabilityOptions } from '../types/options'
import { expressAdapter } from '../frameworks/express'
import { validateOptions } from '../modules/idempotency/validation'

/**
 * Primary entry point for the reliability-kit library.
 *
 * Returns a framework-specific middleware function pre-configured with
 * the requested reliability modules (idempotency, logging, etc.). The
 * returned middleware is passed directly to the framework's use() method
 * — the library handles all internal wiring.
 *
 * Framework detection is explicit via the `framework` field rather than
 * automatic — this avoids silent misconfiguration and makes the dependency
 * on a specific framework's request/response model clear at the call site.
 *
 * Currently supported frameworks:
 *   - Framework.EXPRESS — Express 4.x and above
 *
 * Planned (not yet implemented):
 *   - Framework.FASTIFY
 *   - Framework.NODE (raw http.IncomingMessage / http.ServerResponse)
 *
 * @throws {Error} If the framework is not supported.
 *
 * @example
 * ```typescript
 * import express from 'express'
 * import { reliability, Framework } from 'reliability-kit'
 * import { RedisStore } from 'reliability-kit'
 * import Redis from 'ioredis'
 *
 * const app = express()
 *
 * app.use(reliability({
 *   framework: Framework.EXPRESS,
 *   idempotency: {
 *     enabled: true,
 *     store: new RedisStore(new Redis()),
 *     ttl: 86400,
 *     processingTtl: 30,
 *     duplicateStrategy: 'cache',
 *     onStoreFailure: 'strict',
 *   }
 * }))
 * ```
 */
export function reliability(options: ReliabilityOptions) {
  validateOptions(options)
  switch (options.framework) {
    case Framework.EXPRESS:
      // Delegate to the Express adapter which bridges ReliabilityOptions
      // to Express's req/res/next model and wires up the ReliabilityEngine.
      return expressAdapter(options)

    default:
      // Framework enum value was provided but has no adapter implementation.
      // Throwing here gives a clear error at setup time rather than silently
      // returning undefined and failing later during a request.
      throw new Error(
        `Unsupported framework: '${options.framework}'. ` +
          `Supported frameworks: ${Object.values(Framework).join(', ')}.`,
      )
  }
}
