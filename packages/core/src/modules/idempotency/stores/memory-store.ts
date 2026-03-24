import { IdempotencyStore, IdempotencyRecord } from './store'

/**
 * The shape of a record as stored in the Map.
 *
 * Kept separate from IdempotencyRecord intentionally — this is the
 * internal storage format, while IdempotencyRecord is the public
 * contract between the store and the module. Decoupling them means
 * the internal format can change without breaking the public interface.
 *
 * 'processing' — a lock is held, request is currently being handled.
 * 'completed'  — handler finished, response is cached and ready to serve.
 *
 * Note: unlike RedisStore which stores a JSON string, MemoryStore holds
 * the value directly in memory — no serialization needed.
 */
type StoredRecord = { status: 'processing' } | { status: 'completed'; value: IdempotencyRecord }

/**
 * In-memory idempotency store backed by a Map.
 *
 * Intended for testing and local development only. Not safe for
 * production multi-instance deployments — state lives in the Node.js
 * process and is not shared across instances or server restarts.
 *
 * Atomicity guarantee: because Node.js runs on a single thread, all
 * Map operations between two synchronous statements are inherently
 * atomic. No two async callbacks can interleave between a has() and
 * set() call with no await between them. This is the property that
 * makes acquire() safe without any locking primitive — unlike Redis
 * which needs SET NX, or SQL which needs INSERT ON CONFLICT.
 *
 * TTL management: expiry is handled via setTimeout rather than native
 * TTL support (which doesn't exist for Map). Timers are unref()'d so
 * they don't prevent the Node.js process from exiting — important for
 * test environments where Jest would otherwise report open handles.
 *
 * ⚠️  Do not use in production. Use RedisStore for multi-instance
 * deployments or any environment where idempotency must survive a
 * process restart.
 */
export class MemoryStore implements IdempotencyStore {
  private store = new Map<string, StoredRecord>()

  /**
   * Namespaces all keys under 'idem:' to mirror RedisStore's key format
   * and avoid collisions if the Map is ever shared with other data.
   * Keeps both stores consistent so behaviour is predictable when
   * swapping MemoryStore for RedisStore in tests vs production.
   */
  private getKey(key: string): string {
    return `idem:${key}`
  }

  /**
   * Returns the completed record for a key, or null if missing/processing.
   *
   * Only surfaces completed records — processing records return null
   * intentionally. The module uses this return value after a failed
   * acquire() to decide whether to serve a cached response or return
   * a 409 in-progress. Returning null for processing records keeps
   * that branching logic in the module where it belongs.
   */
  async get(key: string): Promise<IdempotencyRecord | null> {
    const record = this.store.get(this.getKey(key))

    if (!record) return null

    // Only surface completed records — processing records are treated
    // as not ready so the caller receives a 409 in-progress instead.
    if (record.status === 'completed') {
      return record.value
    }

    return null
  }

  /**
   * Transitions a key from 'processing' → 'completed' and stores the
   * response so future duplicate requests can be served from cache.
   *
   * Schedules TTL-based cleanup via setTimeout when ttlSeconds is provided.
   * The timer is unref()'d so it does not prevent the process from exiting
   * — critical in test environments to avoid Jest reporting open handles.
   *
   * ⚠️  If the process restarts before the timeout fires, the record is
   * lost. This is acceptable for a MemoryStore but is a key reason not
   * to use it in production — RedisStore persists records across restarts
   * (within its own durability limits).
   */
  async set(key: string, value: IdempotencyRecord, ttlSeconds?: number): Promise<void> {
    this.store.set(this.getKey(key), {
      status: 'completed',
      value,
    })

    if (ttlSeconds) {
      // unref() ensures this timer does not keep the Node.js process alive
      // after all other work is done — prevents open handle warnings in Jest.
      setTimeout(() => {
        this.store.delete(this.getKey(key))
      }, ttlSeconds * 1000).unref()
    }
  }

  /**
   * Unconditionally removes a key regardless of its current status.
   *
   * This is a maintenance/cleanup tool — it does not check whether the
   * record is processing or completed before deleting. Calling this on
   * a completed record wipes the cached response, causing the next
   * request to re-execute the handler.
   *
   * For releasing a processing lock during error recovery, always use
   * release() instead — it guards against accidentally wiping a completed
   * record by checking status before deleting.
   */
  async delete(key: string): Promise<void> {
    this.store.delete(this.getKey(key))
  }

  /**
   * Atomically acquires a processing lock for the given key.
   *
   * Returns true  → lock acquired, caller may proceed with the handler.
   * Returns false → key already exists (processing or completed), caller
   *                 should return 409 or serve the cached response.
   *
   * "Atomic" here is guaranteed by Node.js's single-threaded event loop —
   * nothing can run between has() and set() since there is no await between
   * them. This is the in-process equivalent of Redis SET NX or SQL
   * INSERT ON CONFLICT — same guarantee, different mechanism.
   *
   * The processingTtl timeout is a safety net: if the handler crashes
   * before release() or set() is called (unhandled rejection, process
   * signal, etc.), the lock self-destructs after ttlSeconds so future
   * retries aren't permanently blocked waiting for a lock that will
   * never be released.
   *
   * The timeout checks status before deleting to avoid wiping a completed
   * record if set() already ran before the timeout fires — this can happen
   * if the handler is slow but does eventually complete within processingTtl.
   */
  async acquire(key: string, ttlSeconds: number): Promise<boolean> {
    if (this.store.has(this.getKey(key))) return false

    this.store.set(this.getKey(key), { status: 'processing' })

    // Safety net timer — expires the lock if the handler never completes.
    // unref()'d so it doesn't block process exit in test environments.
    setTimeout(() => {
      const current = this.store.get(this.getKey(key))
      if (current?.status === 'processing') {
        this.store.delete(this.getKey(key))
      }
    }, ttlSeconds * 1000).unref()

    return true
  }

  /**
   * Releases a processing lock early — called when the handler throws
   * so retries can re-acquire and re-execute immediately rather than
   * waiting up to processingTtl seconds for the lock to expire naturally.
   *
   * Guards against wiping a completed record by checking status before
   * deleting. Safe to call unconditionally — silently no-ops if the key
   * is missing or already completed, so callers never need to check first.
   *
   * No locking primitive is needed here — the status check and delete
   * are synchronous statements with no await between them, so they cannot
   * be interleaved with another operation in the same process. This is
   * the same atomicity guarantee that makes acquire() safe, and is unique
   * to single-threaded in-process stores. RedisStore needs a guarded
   * GET + DEL for the same reason MemoryStore does not.
   */
  async release(key: string): Promise<void> {
    const record = this.store.get(this.getKey(key))
    if (record?.status === 'processing') {
      this.store.delete(this.getKey(key))
    }
    // 'completed' → do nothing, the cached response must be preserved
    // so future duplicates can still be served from cache.
  }
}
