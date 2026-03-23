/**
 * The shape of a completed idempotency record returned by the store.
 *
 * This is the public contract between the store and the module — every
 * store implementation (MemoryStore, RedisStore, custom SQL store) must
 * return this shape from get() and accept it in set().
 *
 * Kept intentionally loose on `response` (unknown) because the library
 * has no knowledge of what the handler returns — that's the caller's
 * domain. Callers who want type safety can cast response to their own
 * type after retrieving it.
 *
 * `status` is optional here for backwards compatibility — internally
 * the module always writes 'completed' when calling set(), so stores
 * can rely on that invariant even if the field is absent on older records.
 */
export interface IdempotencyRecord {
  /**
   * The response body produced by the handler.
   * Typed as unknown — the library does not know or enforce the shape.
   * Callers should cast to their own response type when reading.
   */
  response: unknown

  /**
   * The HTTP status code produced by the handler.
   * Optional — if absent, the module defaults to 200 when replaying
   * a cached response to a duplicate request.
   */
  statusCode?: number

  /**
   * The lifecycle state of this record.
   *
   * 'processing' — a lock is held, the handler is currently executing.
   *                Stores return null from get() for processing records
   *                so the module returns 409 rather than a cached response.
   * 'completed'  — the handler finished, response is safe to replay.
   *
   * Optional for backwards compatibility with records written before
   * this field was introduced.
   */
  status?: 'processing' | 'completed'

  /**
   * A short string that identifies the shape of the original request.
   * Stored alongside the response on first execution and validated on
   * every subsequent duplicate to detect key reuse across different requests.
   *
   * The value depends on fingerprintStrategy:
   *   'method'      → raw HTTP method string e.g. 'POST'
   *   'method+path' → SHA-256 of method + normalized path + query string
   *   'full'        → SHA-256 of method + path + JSON-serialized body
   *
   * Optional — records written before fingerprinting was introduced (v0.1.x)
   * have no fingerprint. The module skips validation for these records
   * gracefully so rolling upgrades work without 422 errors on existing keys.
   *
   * A mismatch between the incoming request fingerprint and the stored
   * fingerprint returns 422 — the client reused a key for a different request.
   */
  fingerprint?: string | undefined
}

/**
 * Contract that all idempotency store implementations must satisfy.
 *
 * The library ships two implementations:
 *   - MemoryStore  — single-process, for testing and local development
 *   - RedisStore   — distributed, for production multi-instance deployments
 *
 * Custom stores (e.g. SQL-backed) can be built by implementing this
 * interface directly. The minimum viable implementation requires only
 * get(), set(), and delete(). acquire() and release() are optional but
 * strongly recommended — without acquire(), idempotency degrades to
 * best-effort and concurrent duplicate requests can both execute the
 * handler simultaneously.
 *
 * @example
 * ```typescript
 * class PostgresStore implements IdempotencyStore {
 *   async acquire(key, ttl) {
 *     // INSERT INTO idempotency_keys ... ON CONFLICT DO NOTHING
 *   }
 *   async release(key) {
 *     // DELETE FROM idempotency_keys WHERE key = $1 AND status = 'processing'
 *   }
 *   async get(key) { ... }
 *   async set(key, value, ttl) { ... }
 *   async delete(key) { ... }
 * }
 * ```
 */
export interface IdempotencyStore {
  /**
   * Returns the completed record for a key, or null if the key is
   * missing or still processing.
   *
   * Implementations should return null for processing records — the
   * module interprets null as "not ready" and returns 409 in-progress
   * to the caller. Only completed records should be surfaced.
   *
   * @param key — the raw idempotency key from the request header,
   *              without any store-specific namespace prefix.
   */
  get(key: string): Promise<IdempotencyRecord | null>

  /**
   * Persists a completed record so future duplicate requests can be
   * served from cache without re-executing the handler.
   *
   * Called only after the handler succeeds — never called if the handler
   * throws. The module always passes status: 'completed' in the value.
   *
   * If ttlSeconds is provided, the record should expire after that many
   * seconds. If omitted, the record persists indefinitely — implementations
   * should document their behaviour when ttlSeconds is absent.
   *
   * @param key        — the raw idempotency key, without namespace prefix.
   * @param value      — the completed record to store, including response and statusCode.
   * @param ttlSeconds — how long to retain the record before expiry.
   */
  set(key: string, value: IdempotencyRecord, ttlSeconds?: number): Promise<void>

  /**
   * Unconditionally removes a key regardless of its current status.
   *
   * This is a maintenance and cleanup tool — it does not check whether
   * the record is processing or completed before deleting. For releasing
   * a processing lock during error recovery, use release() instead, which
   * guards against accidentally wiping a completed record.
   *
   * @param key — the raw idempotency key, without namespace prefix.
   */
  delete(key: string): Promise<void>

  /**
   * Atomically acquires a processing lock for the given key.
   *
   * This is the critical method for concurrency safety. Without it,
   * two concurrent requests with the same key can both pass the get()
   * check simultaneously and both execute the handler — defeating the
   * purpose of idempotency.
   *
   * Implementations must guarantee that only one caller receives true
   * for a given key at any point in time:
   *   - MemoryStore: Node.js single-threaded event loop (has() + set() with no await)
   *   - RedisStore:  SET NX EX (atomic Redis command)
   *   - SQL store:   INSERT ON CONFLICT DO NOTHING (database-level unique constraint)
   *
   * Returns true  → lock acquired, caller may proceed with the handler.
   * Returns false → key already exists (processing or completed).
   *
   * The ttl parameter sets how long the lock lives before auto-expiring.
   * This is a safety net for crashed processes — the lock self-destructs
   * after ttl seconds so retries aren't permanently blocked.
   *
   * Optional — if not implemented, the module falls back to best-effort
   * idempotency and warns at runtime. In strict mode (onStoreFailure: 'strict'),
   * the module throws at construction time if acquire() is absent.
   *
   * @param key — the raw idempotency key, without namespace prefix.
   * @param ttl — lock expiry in seconds.
   */
  acquire?(key: string, ttl?: number): Promise<boolean>

  /**
   * Releases a processing lock early so retries can re-acquire and
   * re-execute immediately rather than waiting for the ttl to expire.
   *
   * Called by the module when the handler throws — work did not happen,
   * so it is safe to release the lock. Implementations must guard against
   * wiping a completed record: only delete the key if status is still
   * 'processing'. If status is 'completed', do nothing.
   *
   * The correct SQL implementation:
   *   DELETE FROM idempotency_keys WHERE key = $1 AND status = 'processing'
   *
   * Optional — if not implemented, the processing lock expires naturally
   * after processingTtl seconds. Implementing release() reduces the window
   * between a handler failure and when retries can proceed.
   *
   * @param key — the raw idempotency key, without namespace prefix.
   */
  release?(key: string): Promise<void>
}
