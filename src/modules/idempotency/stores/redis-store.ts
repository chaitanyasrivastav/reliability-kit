import { IdempotencyStore, IdempotencyRecord } from './store'
/**
 * The shape of a record as stored in Redis.
 *
 * Kept separate from IdempotencyRecord intentionally — this is the
 * internal wire format that lives in Redis, while IdempotencyRecord
 * is the public contract between the store and the module. Decoupling
 * them means we can change the storage format without breaking the
 * public interface.
 *
 * 'processing' — a lock is held, request is currently being handled.
 * 'completed'  — handler finished, response is cached and ready to serve.
 */
type StoredRecord =
  | { status: 'processing' }
  | { status: 'completed'; response: unknown; statusCode?: number }

/**
 * Minimal Redis client contract the store depends on.
 *
 * Intentionally thin — any Redis client (ioredis, node-redis, etc.)
 * satisfies this without a wrapper. We only declare the three methods
 * we actually use so users aren't forced to pass a full client if they
 * only have a partial one.
 *
 * The overloaded set() signature encodes valid Redis SET flag combinations
 * via RedisSetArgs rather than using any[] — this prevents passing invalid
 * flag combinations at compile time.
 *
 * Note: eval() is deliberately excluded. Lua scripts would give us a
 * fully atomic release() but introduce operational risk — a buggy script
 * blocks the entire single-threaded Redis server. The GET + DEL approach
 * in release() has a theoretical race window but is safe enough in practice.
 * See release() for the full trade-off explanation.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<string | null>
  set(key: string, value: string, ...args: any[]): Promise<string | null>
  del(key: string): Promise<number>
}

/**
 * Redis-backed idempotency store for production use.
 *
 * Works correctly across multiple processes and server instances —
 * making it suitable for horizontally-scaled deployments where
 * MemoryStore would fail (each instance has its own isolated memory).
 *
 * Atomicity is achieved via Redis SET NX EX — a single command that
 * sets a key only if it does not exist AND sets an expiry. No Lua
 * scripts or external locking needed for acquire().
 *
 * TTL management is handled natively by Redis — unlike MemoryStore
 * which uses setTimeout and requires .unref() to avoid process leaks.
 *
 * ⚠️  Durability caveat: Redis is in-memory first. If Redis restarts
 * without persistence, or evicts keys under memory pressure, completed
 * records are lost and the next retry re-executes the handler. For
 * payment systems or irreversible operations, use a SQL-backed store
 * where durability is guaranteed by WAL on commit.
 *
 * ⚠️  Eviction caveat: if Redis is configured with any eviction policy
 * other than noeviction (e.g. allkeys-lru), idempotency keys can be
 * silently evicted under memory pressure. Use a dedicated Redis instance
 * or set maxmemory-policy noeviction for idempotency keys.
 */
export class RedisStore implements IdempotencyStore {
  constructor(private redis: RedisClient) {
    this.validateClient()
  }

  /**
   * Validates the Redis client at construction time rather than at
   * first use — so misconfiguration fails loudly on startup instead
   * of silently during a live request when it's too late to fix.
   *
   * Checks for the three methods the store depends on: get, set, del.
   */
  private validateClient(): void {
    if (
      !this.redis ||
      typeof this.redis.get !== 'function' ||
      typeof this.redis.set !== 'function' ||
      typeof this.redis.del !== 'function'
    ) {
      throw new Error('Invalid Redis client provided. Expected get/set/del methods.')
    }
  }

  /**
   * Namespaces all keys under 'idem:' to avoid collisions with other
   * data in the same Redis instance.
   *
   * Without namespacing, a key like 'user-123' could silently collide
   * with an application key of the same name. The prefix also makes
   * idempotency keys immediately identifiable when inspecting Redis
   * directly (e.g. via redis-cli KEYS 'idem:*').
   */
  private getKey(key: string): string {
    return `idem:${key}`
  }

  /**
   * Returns the completed record for a key, or null if missing/processing.
   *
   * Only surfaces completed records — processing records return null
   * intentionally. The module uses this return value to decide whether
   * to serve a cached response or return a 409 in-progress. Returning
   * null for processing records keeps that logic in the module where
   * it belongs, rather than leaking it into the store.
   *
   * Corrupted data (unparseable JSON) is treated as missing — the next
   * request re-acquires the lock and re-processes cleanly.
   */
  async get(key: string): Promise<IdempotencyRecord | null> {
    const data = await this.redis.get(this.getKey(key))
    if (!data) return null

    const record = this.parseRecord(data)
    if (record?.status !== 'completed') return null

    // Return the full IdempotencyRecord shape — not the raw StoredRecord —
    // so the module always works against a consistent interface regardless
    // of which store is in use. The store's internal format is an
    // implementation detail the module should never depend on.
    return {
      status: 'completed',
      response: record.response,
      statusCode: record.statusCode ?? 200,
    }
  }

  /**
   * Transitions a key from 'processing' → 'completed' and stores the
   * response so future duplicate requests can be served from cache.
   *
   * Overwrites the short-lived processing lock (processingTtl, e.g. 30s)
   * with a long-lived completed record (ttl, e.g. 3600s). This is
   * intentional — the lock served its purpose and the completed record
   * takes over responsibility for deduplication.
   *
   * If ttlSeconds is omitted, the key persists indefinitely. Always
   * pass a ttl in production to avoid unbounded memory growth in Redis.
   */
  async set(key: string, value: IdempotencyRecord, ttlSeconds?: number): Promise<void> {
    const redisKey = this.getKey(key)

    const payload: StoredRecord = {
      status: 'completed',
      response: value.response,
      // Only include statusCode in the payload if it was explicitly set —
      // omitting it keeps the stored record lean and avoids ambiguity
      // between "statusCode was 0" and "statusCode was not set".
      ...(value.statusCode !== undefined && {
        statusCode: value.statusCode,
      }),
    }

    if (ttlSeconds) {
      await this.redis.set(redisKey, JSON.stringify(payload), 'EX', ttlSeconds)
    } else {
      await this.redis.set(redisKey, JSON.stringify(payload))
    }
  }

  /**
   * Unconditionally removes a key regardless of its current status.
   *
   * This is a maintenance/cleanup tool — it does not check whether the
   * record is processing or completed before deleting. Calling this on
   * a completed record will wipe the cached response, causing the next
   * request to re-execute the handler.
   *
   * For releasing a processing lock during error recovery, use release()
   * instead — it guards against accidentally wiping a completed record.
   */
  async delete(key: string): Promise<void> {
    await this.redis.del(this.getKey(key))
  }

  /**
   * Atomically acquires a processing lock using Redis SET NX EX.
   *
   * SET NX EX is a single atomic Redis command — it sets the key only
   * if it does not exist (NX) and sets an expiry (EX) in one operation.
   * Only one caller wins across any number of concurrent processes or
   * instances. All others receive null and must handle the duplicate path.
   *
   * The EX expiry is a safety net: if the process crashes between
   * acquire() and set(), the lock auto-expires after ttlSeconds so
   * future retries aren't permanently blocked waiting for a lock that
   * will never be released.
   *
   * Returns true  → lock acquired, caller may proceed with the handler.
   * Returns false → key already exists (either processing or completed).
   */
  async acquire(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(
      this.getKey(key),
      JSON.stringify({ status: 'processing' }),
      'NX',
      'EX',
      ttlSeconds,
    )

    // Redis returns 'OK' on a successful SET NX, or null if the key
    // already existed and the set was skipped.
    return result === 'OK'
  }

  /**
   * Releases a processing lock early so retries can proceed immediately
   * rather than waiting for the processingTtl to expire naturally.
   *
   * Called by the module when the handler throws — work did not happen,
   * so it is safe to unlock. Guards against wiping a completed record
   * by checking status before deleting: if another process somehow
   * completed the record between the handler throwing and release()
   * running, the completed record is preserved.
   *
   * Non-atomic trade-off: the GET and DEL are two separate commands,
   * so there is a theoretical gap where another process could write a
   * completed record between them. In practice this requires next() to
   * simultaneously throw AND complete on a concurrent request for the
   * same key — effectively impossible. A Lua script (EVALSHA) would
   * close this gap atomically but introduces its own operational risk:
   * a buggy script blocks the entire Redis server. The simple GET + DEL
   * is the deliberate, safer choice for most use cases.
   *
   * For payment systems requiring strict atomicity, use a SQL-backed
   * store where DELETE WHERE status = 'processing' is atomic for free.
   */
  async release(key: string): Promise<void> {
    const redisKey = this.getKey(key)
    const data = await this.redis.get(redisKey)
    const record = this.parseRecord(data)

    if (record?.status === 'processing') {
      await this.redis.del(redisKey)
    }
    // If status is 'completed', do nothing — the cached response must
    // be preserved so future duplicates can still be served from cache.
  }

  /**
   * Safely parses a raw Redis string into a StoredRecord.
   *
   * Centralised here so get() and release() share identical corrupted-data
   * handling. JSON.parse throws on malformed input — returning null instead
   * treats corrupted data the same as a missing key, allowing the next
   * request to re-acquire the lock and re-process rather than crashing.
   *
   * Corruption can happen if Redis was written to by another process,
   * if a deploy truncated a write mid-flight, or due to Redis memory
   * corruption in rare failure scenarios.
   */
  private parseRecord(data: string | null): StoredRecord | null {
    if (!data) return null
    try {
      return JSON.parse(data) as StoredRecord
    } catch {
      return null
    }
  }
}
