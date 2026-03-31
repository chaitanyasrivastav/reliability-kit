import { createHash } from 'crypto'
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
 * Controls how strictly duplicate requests are validated against the
 * original request that created the idempotency key.
 *
 * When a duplicate arrives and a completed record exists, the module
 * compares the incoming request against the stored fingerprint. If they
 * differ, the request is rejected with 422.
 *
 * 'method'      — validates HTTP method only. A key used with POST cannot
 *                 be reused with GET. Zero CPU cost — just a string comparison.
 *                 Default — catches the most common client mistake at no overhead.
 *                 Suitable for: internal services, trusted clients, low-risk ops.
 *
 * 'method+path' — validates method and path including query string (params
 *                 sorted for consistency). Different query params = different
 *                 fingerprint. SHA-256 hash for bounded storage size.
 *                 Suitable for: public APIs, multiple endpoints, untrusted clients.
 *
 * 'full'        — validates method, path, query string, and request body.
 *                 SHA-256 of all — any difference returns 422.
 *                 Adds JSON.stringify + hashing cost per request.
 *                 Suitable for: payment flows where body integrity must be guaranteed.
 */
export type FingerprintStrategy = 'method' | 'method+path' | 'full'

const RFC_NON_IDEMPOTENT_METHODS = new Set(['POST', 'PUT', 'PATCH'])
const MAX_IDEMPOTENCY_KEY_LENGTH = 255

// Printable visible ASCII only. Space (0x20) is intentionally excluded
// because whitespace-bearing keys are easy to mangle in clients, logs,
// and proxy layers while adding little practical value.
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]+$/

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

  /**
   * How strictly to validate that duplicate requests match the original.
   *
   * A fingerprint is stored alongside the response on first execution.
   * On every subsequent duplicate, the incoming request is fingerprinted
   * and compared to the stored value. A mismatch means the client reused
   * a key for a different request — rejected with 422.
   *
   * Defaults to 'method' — catches wrong-method retries at zero CPU cost.
   * See FingerprintStrategy for full explanation of each option.
   *
   * ⚠️  For payment flows, use 'full' — ensures the request body has not
   * changed between retries, preventing silent wrong-amount charges.
   *
   * Note: 'full' requires the request body to be parsed before the module
   * runs. In Express, ensure reliability() is registered after express.json().
   * In Fastify the wrapper runs after body parsing so this is automatic.
   */
  fingerprintStrategy?: FingerprintStrategy
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
 * │            completed ──► validateFingerprint()                       │
 * │                               │                                      │
 * │                           mismatch ──► 422                           │
 * │                           match    ──► cached response (or 409)      │
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
 * │   completed ──► validateFingerprint() ──► cached response (or 409)  │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * @example Redis (locked path, method fingerprint — default):
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
 *     fingerprintStrategy: 'method',  // default — zero cost
 *   }
 * }))
 * ```
 *
 * @example Payment flow (full fingerprint — body integrity):
 * ```typescript
 * app.use(reliability({
 *   framework: Framework.EXPRESS,
 *   idempotency: {
 *     enabled: true,
 *     store: new RedisStore(redisClient),
 *     fingerprintStrategy: 'full',  // validates method + path + body
 *   }
 * }))
 * ```
 */
export class IdempotencyModule implements ReliabilityModule {
  private readonly keyHeader: string
  private readonly ttl: number
  private readonly processingTtl: number
  private readonly onStoreFailure: FailureMode
  private readonly duplicateStrategy: DuplicateStrategy
  private readonly fingerprintStrategy: FingerprintStrategy
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
    this.fingerprintStrategy = config.fingerprintStrategy ?? 'method'
    this.store = config.store

    // Without acquire(), concurrent duplicate requests can both pass the
    // get() check simultaneously and both execute the handler — defeating
    // the purpose of idempotency. In strict mode this is a hard
    // misconfiguration that must surface immediately on startup, not
    // silently during a live payment request.
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
    const method = ctx.method.toUpperCase()

    // RFC-style idempotency keys are only useful for non-idempotent methods.
    // Skip naturally idempotent reads and metadata requests entirely.
    if (!RFC_NON_IDEMPOTENT_METHODS.has(method)) {
      return next()
    }

    // Case-insensitive header lookup — HTTP headers are case-insensitive
    // by spec but frameworks differ in how they normalise them.
    const rawKey = ctx.headers
      ? Object.entries(ctx.headers).find(([k]) => k.toLowerCase() === this.keyHeader)?.[1]
      : undefined

    // Multi-value headers arrive as string[] in some frameworks.
    // Take the first value — the idempotency key is always a single value.
    const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey

    // No idempotency key — pass through as a normal non-idempotent request.
    if (!idempotencyKey) return next()

    if (!this.isValidIdempotencyKey(idempotencyKey)) {
      ctx.statusCode = 422
      ctx.response = {
        error: 'invalid_idempotency_key',
        message: 'Idempotency-Key must be 1-255 printable ASCII characters.',
      }
      return
    }

    const scopedKey = this.buildScopedKey(ctx, idempotencyKey)

    if (typeof this.store.acquire === 'function') {
      return this.executeLocked(ctx, next, scopedKey)
    }

    // No acquire() — best-effort simple path. Bypass mode only.
    console.warn(
      'Store does not implement acquire() — idempotency is best-effort only. ' +
        'Concurrent duplicate requests may both execute the handler.',
    )
    return this.executeSimple(ctx, next, scopedKey)
  }

  // ── Fingerprinting ────────────────────────────────────────────────────
  //
  // Fingerprints identify the shape of a request — method, path, and
  // optionally body. Stored on first execution. Validated on every
  // subsequent duplicate to catch key reuse across different operations.
  //
  // Performance characteristics:
  //   method      → 3-7 char string, zero cost
  //   method+path → SHA-256 of method + normalized path (~1μs)
  //   full        → SHA-256 of method + path + body (~50μs, body dominates)

  /**
   * Normalizes a path for consistent fingerprinting.
   *
   * - Strips trailing slash: /payments/123/ → /payments/123
   * - Sorts query parameters: ?b=2&a=1 → ?a=1&b=2
   *
   * Sorting query params ensures /payments?a=1&b=2 and /payments?b=2&a=1
   * produce the same fingerprint — they are the same request.
   */
  private normalizePath(path: string): string {
    const queryIndex = path.indexOf('?')
    const cleanPath =
      (queryIndex === -1 ? path : path.slice(0, queryIndex)).replace(/\/$/, '') || '/'

    if (queryIndex === -1) return cleanPath

    const queryString = path.slice(queryIndex + 1)
    const params = new URLSearchParams(queryString)
    const sorted = new URLSearchParams(
      [...params.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ).toString()

    return `${cleanPath}?${sorted}`
  }

  private isValidIdempotencyKey(key: string): boolean {
    return key.length <= MAX_IDEMPOTENCY_KEY_LENGTH && IDEMPOTENCY_KEY_PATTERN.test(key)
  }

  private buildScopedKey(ctx: RequestContext, key: string): string {
    const method = ctx.method.toUpperCase()
    const path = this.normalizePath(ctx.path || '/')
    return `${method}:${path}:${key}`
  }

  private shouldPersistResponse(statusCode: number): boolean {
    // Cache only successful completed operations. Non-2xx responses should
    // generally be allowed to retry rather than replaying a cached failure.
    return statusCode >= 200 && statusCode < 300
  }

  private async safelyReleaseKey(key: string, reason: string): Promise<void> {
    try {
      await this.store.release?.(key)
    } catch (releaseErr) {
      console.error(`Failed to release lock for key ${key} after ${reason}:`, releaseErr)
    }
  }

  /**
   * Builds a fingerprint for the current request.
   *
   * 'method'      → raw method string — never hashed, always short and safe.
   * 'method+path' → SHA-256 of method + normalized path. Hashed to keep
   *                 storage size bounded regardless of path length.
   * 'full'        → SHA-256 of method + path + JSON-serialized body.
   *                 Register reliability() after body parsing middleware
   *                 to ensure ctx.body is populated before this runs.
   */
  private buildFingerprint(ctx: RequestContext): string {
    const method = ctx.method.toUpperCase()

    switch (this.fingerprintStrategy) {
      case 'method':
        return method

      case 'method+path': {
        const path = this.normalizePath(ctx.path || '/')
        return createHash('sha256').update(`${method}:${path}`).digest('hex')
      }

      case 'full': {
        const path = this.normalizePath(ctx.path || '/')

        // Canonicalize missing bodies and empty JSON objects to the same
        // fingerprint. Different adapters expose an absent parsed body as
        // either undefined or {}, and legitimate retries should still match.
        const body = JSON.stringify(ctx.body ?? {})

        return createHash('sha256').update(`${method}:${path}:${body}`).digest('hex')
      }
    }
  }

  /**
   * Validates the incoming request fingerprint against the stored record.
   *
   * Returns true  → fingerprints match, or no fingerprint stored (old record).
   * Returns false → mismatch — client reused the key for a different request.
   *
   * Gracefully passes records without a stored fingerprint — ensures rolling
   * upgrades work correctly where v0.1.x records (no fingerprint) coexist
   * with v0.2.x records in the same store.
   */
  private validateFingerprint(ctx: RequestContext, record: IdempotencyRecord): boolean {
    // No fingerprint stored — old record predating fingerprint support.
    // Skip validation so v0.1.x records still serve cached responses after upgrade.
    if (!record.fingerprint) return true

    return this.buildFingerprint(ctx) === record.fingerprint
  }

  // ── Locked path ───────────────────────────────────────────────────────
  private async executeLocked(
    ctx: RequestContext,
    next: () => Promise<void>,
    key: string,
  ): Promise<void> {
    // ── Step 1: Acquire the processing lock ──────────────────────────
    let acquired = false
    try {
      acquired = await this.store.acquire!(key, this.processingTtl)
    } catch (err) {
      if (this.onStoreFailure === 'strict') throw err
      return next()
    }

    // ── Step 2: Lock not acquired → duplicate in flight ───────────────
    if (!acquired) {
      return this.handleDuplicate(ctx, key)
    }

    // ── Step 3: Lock acquired → execute the handler ───────────────────
    try {
      await next()
    } catch (err) {
      await this.safelyReleaseKey(key, 'handler failure')
      throw err
    }

    // ── Step 4: Persist the completed response ────────────────────────
    await this.persistCompleted(ctx, key, true)
  }

  // ── Simple path ───────────────────────────────────────────────────────
  private async executeSimple(
    ctx: RequestContext,
    next: () => Promise<void>,
    key: string,
  ): Promise<void> {
    let record = null
    try {
      record = await this.store.get(key)
    } catch {
      return next()
    }

    if (record?.status === 'completed') {
      return this.serveCachedResponse(ctx, record)
    }

    await next()
    // Simple path is only reachable in bypass mode — the constructor
    // throws in strict mode when store.acquire is missing.
    // persistCompleted errors are therefore always swallowed here.
    await this.persistCompleted(ctx, key, false)
  }

  // ── Shared: handle duplicate in flight ────────────────────────────────
  private async handleDuplicate(ctx: RequestContext, key: string): Promise<void> {
    let record = null
    try {
      record = await this.store.get(key)
    } catch (err) {
      if (this.onStoreFailure === 'strict') throw err
    }

    if (record?.status === 'completed') {
      return this.serveCachedResponse(ctx, record)
    }

    // Still processing — return 409 with Retry-After
    ctx.statusCode = 409
    ctx.responseHeaders = {
      ...ctx.responseHeaders,
      'Retry-After': String(this.processingTtl),
    }
    ctx.response = {
      error: 'idempotency_key_in_use',
      message: 'A request with this key is already in progress',
      retryAfter: this.processingTtl,
    }
  }

  // ── Shared: serve a cached completed response ─────────────────────────
  //
  // Validates the fingerprint before serving the cached response.
  // A mismatch means the client reused an idempotency key for a different
  // request — rejected with 422 (Unprocessable Entity).
  //
  // 422 is the correct status here — 409 means "duplicate request", 422
  // means "your request is semantically invalid". Using 409 would mislead
  // clients into thinking the key is still valid for retry.
  private serveCachedResponse(ctx: RequestContext, record: IdempotencyRecord): void {
    // ── Fingerprint validation ─────────────────────────────────────────
    //
    // Catches key reuse across different operations:
    //   GET /payments  key:"1" → cached
    //   POST /payments key:"1" → 422 (method mismatch with 'method' strategy)
    //
    //   POST /payments { amount: 100 } key:"1" → cached
    //   POST /payments { amount: 999 } key:"1" → 422 (body mismatch with 'full' strategy)
    if (!this.validateFingerprint(ctx, record)) {
      ctx.statusCode = 422
      ctx.response = {
        error: 'idempotency_key_mismatch',
        message: 'This idempotency key was used with a different request. Use a new key.',
      }
      return
    }

    if (this.duplicateStrategy === 'reject') {
      ctx.statusCode = 409
      ctx.response = {
        error: 'duplicate_request',
        message: 'A request with this idempotency key has already been completed',
      }
      return
    }

    ctx.responseHeaders = {
      ...ctx.responseHeaders,
      'Idempotency-Replayed': 'true',
    }
    ctx.response = record.response
    ctx.statusCode = record.statusCode ?? 200
  }

  // ── Shared: persist the completed response ────────────────────────────
  //
  // Stores the fingerprint alongside the response so future duplicates
  // can be validated against the original request.
  //
  // ⚠️  CRITICAL: never call release() or delete() if this fails.
  // The handler already ran — releasing the lock would allow a retry to
  // re-execute and produce a duplicate side effect.
  private async persistCompleted(
    ctx: RequestContext,
    key: string,
    lockHeld: boolean,
  ): Promise<void> {
    const statusCode = ctx.statusCode ?? 200

    if (!this.shouldPersistResponse(statusCode)) {
      // Only the locked path has an in-flight processing lock to release.
      if (lockHeld) {
        await this.safelyReleaseKey(key, `non-cacheable ${statusCode} response`)
      }
      return
    }

    try {
      await this.store.set(
        key,
        {
          status: 'completed',
          response: ctx.response,
          statusCode,
          fingerprint: this.buildFingerprint(ctx),
        },
        this.ttl,
      )
    } catch (err) {
      if (this.onStoreFailure === 'strict') throw err
      console.error(`Failed to store completed response for key ${key}:`, err)
    }
  }
}
