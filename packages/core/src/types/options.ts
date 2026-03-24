import { IdempotencyStore } from '../modules/idempotency/stores/store'
import { DuplicateStrategy, FailureMode } from '../modules/idempotency/idempotency'

/**
 * Top-level configuration passed to the reliability() entry point.
 *
 * Groups all module configurations under a single object so the library
 * has one clear setup call. Each module is opt-in — only include the
 * modules your application needs. Omitted modules add zero overhead.
 *
 * @example Minimal setup — idempotency only:
 * ```typescript
 * app.use(reliability({
 *   framework: Framework.EXPRESS,
 *   idempotency: {
 *     enabled: true,
 *     store: new RedisStore(redisClient),
 *   }
 * }))
 * ```
 *
 * @example Full configuration:
 * ```typescript
 * app.use(reliability({
 *   framework: Framework.EXPRESS,
 *   idempotency: {
 *     enabled: true,
 *     store: new RedisStore(redisClient),
 *     ttl: 86400,
 *     processingTtl: 30,
 *     duplicateStrategy: 'cache',
 *     onStoreFailure: 'strict',
 *   }
 * }))
 * ```
 */
export interface ReliabilityOptions {
  /**
   * Idempotency module configuration.
   *
   * When provided with enabled: true, wraps every request in an
   * acquire → execute → complete state machine that guarantees the
   * handler runs at most once per idempotency key within the ttl window.
   *
   * Omit this field entirely (or set enabled: false) to disable
   * idempotency — the module is not constructed and adds no overhead.
   */
  idempotency?: IdempotencyOptions
}

/**
 * Configuration for the idempotency module.
 *
 * Controls how duplicate requests are detected, stored, and responded to.
 * See IdempotencyModule for a full explanation of the state machine and
 * concurrency guarantees.
 *
 * Minimum required configuration:
 * ```typescript
 * { enabled: true, store: new RedisStore(client) }
 * ```
 *
 * All other fields have sensible defaults suitable for most use cases.
 * Override them only when the defaults don't fit your requirements.
 */
export interface IdempotencyOptions {
  /**
   * Whether the idempotency module is active.
   *
   * When false (or omitted), the module is not constructed and requests
   * pass through without any idempotency checks. Useful for disabling
   * idempotency in development or test environments without removing
   * the configuration entirely.
   */
  enabled: boolean

  /**
   * The request header name to read the idempotency key from.
   * Matched case-insensitively against incoming request headers.
   *
   * Defaults to 'Idempotency-Key' — the de facto standard used by
   * Stripe, PayPal, and most payment APIs. Only change this if you
   * are integrating with a client that uses a different header name.
   */
  key?: string

  /**
   * The store implementation used to persist idempotency state.
   *
   * The store is the most important configuration decision:
   *   RedisStore   → production, multi-instance deployments.
   *   MemoryStore  → local development and testing only.
   *   Custom store → implement IdempotencyStore for SQL or other backends.
   *
   * Required — the module cannot function without a store.
   */
  store: IdempotencyStore

  /**
   * How long to retain completed responses in the store (seconds).
   *
   * Duplicate requests arriving within this window are served the cached
   * response without re-executing the handler. Requests arriving after
   * this window are treated as new and re-execute the handler.
   *
   * Set this to match your client's retry window:
   *   Payment flows  → 86400 (24 hours)
   *   API calls      → 3600  (1 hour, default)
   *   Short ops      → 300   (5 minutes)
   *
   * Defaults to 3600 (1 hour).
   */
  ttl?: number

  /**
   * How long the processing lock is held before auto-expiring (seconds).
   *
   * This is a crash safety net — not the normal lifecycle. Under normal
   * operation the lock is replaced by a completed record (on success) or
   * released immediately (on handler failure). The processingTtl only
   * matters when the process crashes mid-execution, leaving the lock
   * stuck as 'processing' with no one to release it.
   *
   * Set higher than your p99 handler latency to avoid the lock expiring
   * during legitimate slow requests. Set low enough that a crashed process
   * doesn't block retries for longer than necessary.
   *
   * Defaults to 30 seconds.
   */
  processingTtl?: number

  /**
   * How to respond when a duplicate request arrives and a completed
   * response already exists in the store.
   *
   * 'cache'  → return the original response transparently. The caller
   *            cannot tell it was a duplicate. Matches Stripe's behaviour.
   *            This is the default.
   *
   * 'reject' → return 409 Conflict explicitly. Use when callers must be
   *            told they are retrying — e.g. internal services that track
   *            request state and would behave incorrectly on a transparent
   *            replay.
   *
   * Defaults to 'cache'.
   */
  duplicateStrategy?: DuplicateStrategy

  /**
   * How the module should behave when the store encounters an error.
   *
   * 'strict' → throw the error and fail the request. This is the default
   *            and recommended for most use cases — it guarantees that
   *            idempotency is never silently bypassed due to a store
   *            failure, which could lead to duplicate side effects.
   *
   * 'bypass' → log the error but allow the request to proceed without
   *            idempotency guarantees. Use only in extreme cases where
   *            availability is more important than consistency, and you
   *            have monitoring in place to detect and alert on store
   *            failures so you can intervene manually.
   *
   * Defaults to 'strict'.
   */
  onStoreFailure?: FailureMode

  /**
   * How strictly to validate that duplicate requests match the original
   * request that created the idempotency key.
   *
   * A fingerprint is computed from the incoming request and stored alongside
   * the response on first execution. On every subsequent duplicate, the
   * fingerprint is recomputed and compared to the stored value. A mismatch
   * means the client reused a key for a different request — rejected with 422.
   *
   * 'method' — fingerprints the HTTP method only. Zero CPU cost — a 3-7
   *            character string comparison. Catches the most common client
   *            mistake: retrying with the wrong method (e.g. GET instead of
   *            POST). Does not catch body or path changes.
   *            Default — appropriate for most APIs.
   *
   * 'method+path' — fingerprints the HTTP method, path, and query string.
   *                 Path is normalized (trailing slash stripped). Query params
   *                 are preserved as-is — param order is the client's
   *                 responsibility. SHA-256 hashed for bounded storage size
   *                 regardless of path length. Catches wrong-endpoint retries
   *                 and query string changes.
   *                 Suitable for public APIs with multiple endpoints.
   *
   * 'full' — fingerprints method, path, query string, and request body.
   *          SHA-256 of all four — any difference returns 422. Body is
   *          serialized via JSON.stringify before hashing, so field insertion
   *          order matters. Adds ~50μs per request (body serialization
   *          dominates). Catches silent wrong-amount or wrong-payload retries.
   *          Suitable for payment flows where body integrity must be guaranteed.
   *
   *          ⚠️  Requires the request body to be parsed before the module runs.
   *          In Express, register reliability() after express.json(). If body
   *          is undefined when this runs, the fingerprint is computed from {}
   *          and body changes on retry will not be detected.
   *          In Fastify the wrapper runs after body parsing automatically.
   *
   * Records written before fingerprinting was introduced have no stored
   * fingerprint — validation is skipped for these records so rolling upgrades
   * work correctly without 422 errors on existing keys.
   *
   * Defaults to 'method'.
   */
  fingerprintStrategy?: 'method' | 'method+path' | 'full'
}
