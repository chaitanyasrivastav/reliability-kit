import { ReliabilityModule } from '../../core/module'
import { RequestContext } from '../../core/context'
import { IdempotencyStore, IdempotencyRecord } from './stores/store'

/**
 * Controls how the module behaves when the store throws an error.
 *
 * 'strict' — any store failure (acquire, get, or set) throws and aborts
 *            the request. Use when duplicate execution is unacceptable —
 *            payments, emails, order creation, or any irreversible operation.
 *            This is the default and the safer choice.
 *
 * 'bypass' — store failures are swallowed and the request proceeds without
 *            idempotency protection. Use when idempotency is a convenience
 *            rather than a hard requirement and availability matters more
 *            than duplicate safety — e.g. analytics events, read operations.
 *
 * ⚠️  In bypass mode, a store outage silently removes all idempotency
 * guarantees for the duration of the outage. Concurrent retries can
 * both execute the handler. Only use bypass if that outcome is acceptable.
 */
export type FailureMode = 'strict' | 'bypass'

/**
 * Controls how the module responds when a duplicate request arrives and
 * a completed response already exists in the store.
 *
 * 'cache'  — returns the original response transparently. The caller has
 *            no indication it was a duplicate — it looks like a normal
 *            successful response. This is the default and matches the
 *            behaviour of Stripe, Shopify, and most payment APIs.
 *
 * 'reject' — returns 409 Conflict even though a completed response exists.
 *            Use when callers must be explicitly told they are retrying —
 *            e.g. internal services where the client tracks request state
 *            and a transparent replay would cause incorrect behaviour.
 */
export type DuplicateStrategy = 'cache' | 'reject'

/**
 * Configuration for the IdempotencyModule.
 * All fields except `store` are optional and have sensible defaults.
 */
export interface IdempotencyConfig {
  /**
   * The request header name to read the idempotency key from.
   * Matched case-insensitively against incoming request headers.
   * Defaults to 'Idempotency-Key' — the de facto standard used by
   * Stripe, PayPal, and most payment APIs.
   */
  key?: string

  /**
   * The store implementation to use for persisting idempotency state.
   *
   * Shipped stores:
   *   RedisStore  → production, multi-instance deployments.
   *   MemoryStore → local development and testing only.
   *
   * Custom stores (BYOS):
   *   Implement acquire() for concurrency-safe idempotency.
   *   Any backend that supports a conditional write is suitable:
   *     Redis:    SET NX EX
   *     SQL:      INSERT ON CONFLICT DO NOTHING
   *     DynamoDB: ConditionExpression attribute_not_exists
   *     MongoDB:  findOneAndUpdate with $setOnInsert
   *
   *   Omit acquire() for best-effort idempotency (bypass mode only) —
   *   suitable for analytics, reads, or operations that are safe to
   *   execute more than once under rare concurrent conditions.
   *
   * Required — the module cannot function without a store.
   */
  store: IdempotencyStore

  /**
   * How long to retain completed responses in the store (seconds).
   *
   * Duplicate requests arriving within this window are served the cached
   * response. Requests arriving after this window are treated as new and
   * re-execute the handler. Set this to match your client's retry window
   * — typically 24 hours (86400) for payment flows.
   *
   * Defaults to 3600 (1 hour).
   */
  ttl?: number

  /**
   * How to behave when the store throws an error.
   * Defaults to 'strict'. See FailureMode for full explanation.
   */
  onStoreFailure?: FailureMode

  /**
   * How to handle a duplicate request when a completed response exists.
   * Defaults to 'cache'. See DuplicateStrategy for full explanation.
   */
  duplicateStrategy?: DuplicateStrategy

  /**
   * How long the processing lock is held before it auto-expires (seconds).
   *
   * This is a safety net — not the normal lifecycle. Under normal operation
   * the lock is replaced by a completed record (set()) or released early
   * (release()). The processingTtl only matters when the process crashes
   * between acquire() and set(), leaving the lock stuck as 'processing'.
   *
   * Set this higher than your p99 handler latency to avoid the lock
   * expiring mid-execution under load. Set it low enough that a crashed
   * process doesn't block retries for too long.
   *
   * Defaults to 30 seconds.
   */
  processingTtl?: number
}

/**
 * Middleware module that makes any request handler idempotent.
 *
 * Wraps the handler in a state machine driven by an idempotency key the
 * client sends in a request header. The key uniquely identifies a logical
 * operation — the same key always produces the same result, no matter how
 * many times it is sent.
 *
 * Automatically routes to the correct execution path based on what the
 * store implements:
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  Locked path — store implements acquire()                            │
 * │  Works with: Redis (SET NX), SQL (INSERT ON CONFLICT),               │
 * │              DynamoDB (ConditionExpression), MongoDB ($setOnInsert)   │
 * │                                                                      │
 * │  acquire() ──► next() ──► set()       ← happy path                  │
 * │      │                     │                                         │
 * │      │                  release()     ← if next() throws             │
 * │      │                                                               │
 * │   false ──► get()                                                    │
 * │               │                                                      │
 * │            completed ──► cached response (or 409 reject)            │
 * │            processing ──► 409 in-progress + Retry-After             │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  Simple path — store does not implement acquire()                    │
 * │  Best-effort only — bypass mode required, strict mode throws         │
 * │  Suitable for: analytics, reads, low-risk operations                 │
 * │                                                                      │
 * │  get() ──► null ──► next() ──► set()  ← no concurrency guarantee    │
 * │      │                                                               │
 * │   completed ──► cached response (or 409 reject)                     │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * @example Redis (locked path):
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
 *
 * @example SQL custom store (locked path via acquire()):
 * ```typescript
 * class PostgresStore implements IdempotencyStore {
 *   async acquire(key, ttl) {
 *     const result = await db.query(
 *       `INSERT INTO idempotency_keys (key, status, expires_at)
 *        VALUES ($1, 'processing', now() + ($2 || ' seconds')::interval)
 *        ON CONFLICT (key) DO NOTHING`,
 *       [key, ttl]
 *     )
 *     return result.rowCount > 0  // true = won, false = key exists
 *   }
 * }
 * ```
 */
export class IdempotencyModule implements ReliabilityModule {
  private readonly keyHeader: string
  private readonly ttl: number
  private readonly processingTtl: number
  private readonly onStoreFailure: FailureMode
  private readonly duplicateStrategy: DuplicateStrategy
  private readonly store: IdempotencyStore

  constructor(config: IdempotencyConfig) {
    // Normalize the header name to lowercase once at construction time
    // so every per-request lookup is a simple case-insensitive string
    // comparison with no repeated transformation.
    this.keyHeader = (config.key ?? 'Idempotency-Key').toLowerCase()
    this.ttl = config.ttl ?? 3600
    this.processingTtl = config.processingTtl ?? 30
    this.onStoreFailure = config.onStoreFailure ?? 'strict'
    this.duplicateStrategy = config.duplicateStrategy ?? 'cache'
    this.store = config.store

    // Without acquire(), concurrent duplicate requests can both pass the
    // get() check simultaneously and both execute the handler — defeating
    // the purpose of idempotency. In strict mode this is a hard
    // misconfiguration that must surface immediately on startup, not
    // silently during a live payment request.
    //
    // acquire() is the universal concurrency primitive — implement it with
    // whatever conditional write your backend supports:
    //   Redis:    SET NX EX → return result === 'OK'
    //   SQL:      INSERT ON CONFLICT DO NOTHING → return rowCount > 0
    //   DynamoDB: ConditionExpression attribute_not_exists
    //   MongoDB:  findOneAndUpdate with $setOnInsert
    //
    // Bypass mode accepts a store without acquire() — suitable for
    // operations where occasional duplicate execution is acceptable.
    if (!this.store.acquire && this.onStoreFailure === 'strict') {
      throw new Error(
        'Store must implement acquire() for concurrency safety. ' +
          'acquire() is the lock primitive — implement it with SET NX EX (Redis), ' +
          'INSERT ON CONFLICT DO NOTHING (SQL), or an equivalent conditional write. ' +
          'Use onStoreFailure: "bypass" to allow best-effort idempotency without acquire().',
      )
    }
  }

  async execute(ctx: RequestContext, next: () => Promise<void>): Promise<void> {
    // Case-insensitive header lookup — HTTP headers are case-insensitive
    // by spec but frameworks differ in how they normalise them. Scanning
    // all entries with a lowercase comparison handles all cases correctly.
    const rawKey = ctx.headers
      ? Object.entries(ctx.headers).find(([k]) => k.toLowerCase() === this.keyHeader)?.[1]
      : undefined

    // Multi-value headers arrive as string[] in some frameworks (e.g. when
    // a header is sent twice). Take the first value — the idempotency key
    // is always a single value; duplicates are a client error.
    const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey

    // No idempotency key present — pass through as a normal non-idempotent
    // request. This allows the module to sit on all routes without forcing
    // every caller to send the header. Routes that don't need idempotency
    // simply omit the header.
    if (!idempotencyKey) return next()

    // Route to the correct execution path based on store capability.
    // acquire() is the universal signal — any store that implements it,
    // regardless of backend (Redis, SQL, DynamoDB, MongoDB), uses the
    // locked path with full concurrency guarantees.
    if (typeof this.store.acquire === 'function') {
      return this.executeLocked(ctx, next, idempotencyKey)
    }

    // No acquire() — best-effort simple path.
    // Constructor already threw in strict mode so this only runs in
    // bypass mode. Warn per request so ops can observe the gap.
    console.warn(
      'Store does not implement acquire() — idempotency is best-effort only. ' +
        'Concurrent duplicate requests may both execute the handler.',
    )
    return this.executeSimple(ctx, next, idempotencyKey)
  }

  // ── Locked path ───────────────────────────────────────────────────────
  //
  // Used by any store that implements acquire() — Redis, Memory, SQL,
  // DynamoDB, MongoDB. The store owns the implementation of acquire(),
  // the module owns the lifecycle orchestration around it.
  //
  // The same three-phase flow works for all backends:
  //   acquire() → execute → set(completed)
  //
  // The only difference between Redis and SQL is what happens inside
  // acquire() — the module never needs to know.
  private async executeLocked(
    ctx: RequestContext,
    next: () => Promise<void>,
    key: string,
  ): Promise<void> {
    // ── Step 1: Acquire the processing lock ──────────────────────────
    //
    // Atomically write a processing record. Only one concurrent request
    // wins — all others receive false and are handled in step 2.
    // The processingTtl sets how long the lock lives before auto-expiring
    // as a crash safety net.
    let acquired = false
    try {
      acquired = await this.store.acquire!(key, this.processingTtl)
    } catch (err) {
      // Store threw during acquire — respect the configured failure mode.
      // Strict: abort the request, surface the error to the caller.
      // Bypass: proceed without idempotency rather than failing entirely.
      if (this.onStoreFailure === 'strict') throw err
      return next()
    }

    // ── Step 2: Lock not acquired → duplicate in flight ───────────────
    //
    // Another request already holds the lock. Fetch the record to
    // determine whether to serve a cached response or return 409.
    if (!acquired) {
      return this.handleDuplicate(ctx, key)
    }

    // ── Step 3: Lock acquired → execute the handler ───────────────────
    //
    // We won the race. Execute the handler. If it throws, release the
    // lock immediately so retries can re-acquire without waiting up to
    // processingTtl seconds for the safety-net expiry to fire.
    try {
      await next()
    } catch (err) {
      // Handler failed — work did NOT happen, safe to release the lock.
      // Use release() not delete() — release() guards against wiping a
      // completed record if called out of order. delete() is unconditional.
      try {
        await this.store.release?.(key)
      } catch (releaseErr) {
        // release() failed — lock expires naturally after processingTtl.
        // Log so ops can observe the extended retry delay, but do not
        // mask the original handler error — that is what the caller needs.
        console.error(`Failed to release lock for key ${key}:`, releaseErr)
      }
      throw err
    }

    // ── Step 4: Persist the completed response ────────────────────────
    await this.persistCompleted(ctx, key)
  }

  // ── Simple path ───────────────────────────────────────────────────────
  //
  // Used when the store does not implement acquire().
  // Best-effort only — bypass mode required, strict mode throws at
  // construction time so this path is never reached in strict mode.
  //
  // Race condition is possible: two concurrent requests can both call
  // get() → null and both execute the handler. Acceptable for operations
  // that are safe to execute more than once (analytics, reads, low-risk
  // writes) or for low-traffic applications where the race is statistically
  // unlikely.
  private async executeSimple(
    ctx: RequestContext,
    next: () => Promise<void>,
    key: string,
  ): Promise<void> {
    // Check if a completed response already exists before executing.
    // If get() fails, proceed without idempotency — bypass mode accepts this.
    let record = null
    try {
      record = await this.store.get(key)
    } catch {
      return next()
    }

    if (record?.status === 'completed') {
      return this.serveCachedResponse(ctx, record)
    }

    // No lock — execute handler.
    // Race condition possible: concurrent requests may both reach here
    // simultaneously. Accepted in bypass mode — use a store with acquire()
    // for strict duplicate prevention.
    await next()

    // Persist result — if this fails, the next retry re-executes the handler.
    // This is the known limitation of the simple path. No release() needed
    // because no processing lock was ever acquired.
    await this.persistCompleted(ctx, key)
  }

  // ── Shared: handle duplicate in flight ────────────────────────────────
  //
  // Called by executeLocked when acquire() returns false.
  // Fetches the record to decide: serve cached response or 409 in-progress.
  private async handleDuplicate(ctx: RequestContext, key: string): Promise<void> {
    let record = null
    try {
      record = await this.store.get(key)
    } catch (err) {
      // get() failed — strict mode rethrows, bypass falls through to the
      // 409 in-progress path. Retrying is safe — handler never executed.
      if (this.onStoreFailure === 'strict') throw err
    }

    if (record?.status === 'completed') {
      return this.serveCachedResponse(ctx, record)
    }

    // Original request is still processing — tell the caller the earliest
    // safe time to retry. The module never polls or retries internally.
    ctx.statusCode = 409
    ctx.headers = { ...ctx.headers, 'Retry-After': String(this.processingTtl) }
    ctx.response = { error: 'Request already in progress', retryAfter: this.processingTtl }
  }

  // ── Shared: serve a cached completed response ─────────────────────────
  //
  // duplicateStrategy controls whether the caller sees the original
  // response transparently (cache) or an explicit 409 (reject).
  private serveCachedResponse(ctx: RequestContext, record: IdempotencyRecord): void {
    if (this.duplicateStrategy === 'reject') {
      ctx.statusCode = 409
      ctx.response = { error: 'Duplicate request' }
      return
    }

    ctx.response = record.response
    ctx.statusCode = record.statusCode ?? 200
  }

  // ── Shared: persist the completed response ────────────────────────────
  //
  // Called after next() succeeds on both paths.
  //
  // ⚠️  CRITICAL: never call release() or delete() if this fails.
  //
  // The handler already ran — its side effects already happened (payment
  // charged, email sent, order created). Releasing the lock here would
  // allow the next retry to re-acquire and re-execute the handler,
  // producing a duplicate side effect. This is exactly what idempotency
  // exists to prevent.
  //
  // On failure: log loudly, let processingTtl expire naturally, and accept
  // that a retry within that window may re-execute. Keep processingTtl
  // short to minimise this window.
  private async persistCompleted(ctx: RequestContext, key: string): Promise<void> {
    try {
      await this.store.set(
        key,
        {
          status: 'completed',
          response: ctx.response,
          statusCode: ctx.statusCode ?? 200,
        },
        this.ttl,
      )
    } catch (err) {
      if (this.onStoreFailure === 'strict') throw err
      console.error(`Failed to store completed response for key ${key}:`, err)
    }
  }
}
