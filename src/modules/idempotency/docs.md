# Idempotency Module

Ensures that duplicate requests with the same key are processed only once — preventing double charges, duplicate orders, or repeated side effects in distributed systems.

---

## Installation

```bash
npm install reliability-kit
```

Supports both CommonJS (`require`) and ESM (`import`).

```typescript
// ESM
import { reliability, Framework } from 'reliability-kit'

// CommonJS
const { reliability, Framework } = require('reliability-kit')
```

---

## Why Idempotency?

In distributed systems, retries are unavoidable. Network failures, timeouts, and load balancers all cause clients to resend requests. Without idempotency, each retry is treated as a new request:

```
POST /orders  →  order created
POST /orders  →  order created again ❌  (client retried after a timeout)
```

With idempotency, the second request returns the same response without re-executing the handler:

```
POST /orders  →  order created
POST /orders  →  same response, no duplicate ✅
```

---

## How It Works

The module automatically routes to the correct execution path based on what the store implements.

### Locked path — store implements `acquire()`

Used by Redis, Memory, SQL, DynamoDB, MongoDB, or any store with a conditional write primitive. Full concurrency safety — only one request executes the handler per key.

```
acquire()  →  next()  →  set()        happy path — handler runs once, response stored
    │                       │
    │                    release()     if next() throws — lock released immediately
    │
  false ──► get()
               │
            completed ──► cached response (or 409 reject)
            processing ──► 409 in-progress + Retry-After
```

**Phase 1 — Acquire:** Atomically write a `processing` lock. Only one concurrent request wins. All others get 409 immediately.

**Phase 2 — Execute:** Run the handler. If it throws, release the lock immediately so retries don't wait for the lock to expire.

**Phase 3 — Store:** Persist the response as `completed`. Future duplicates are served from cache without re-executing the handler.

---

### Simple path — store does not implement `acquire()`

Used for stores without a conditional write primitive. Best-effort only — bypass mode required. Suitable for analytics, reads, or low-risk operations where occasional duplicate execution is acceptable.

```
get() ──► null ──► next() ──► set()   no concurrency guarantee
    │
 completed ──► cached response (or 409 reject)
```

> ⚠️ Without `acquire()`, concurrent duplicate requests may both pass the `get()` check simultaneously and both execute the handler. Only use this path when that outcome is acceptable.

---

## Setup

```typescript
import { reliability, Framework } from 'reliability-kit'
import { RedisStore } from 'reliability-kit'
import Redis from 'ioredis'

const app = express()

app.use(
  reliability({
    framework: Framework.EXPRESS,
    idempotency: {
      enabled: true,
      store: new RedisStore(new Redis()),
      key: 'Idempotency-Key',       // header to read the key from
      ttl: 3600,                    // how long to cache completed responses (seconds)
      processingTtl: 30,            // how long the processing lock lives (seconds)
      duplicateStrategy: 'cache',   // 'cache' | 'reject'
      onStoreFailure: 'strict',     // 'strict' | 'bypass'
    },
  }),
)
```

---

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `framework` | `Framework` | required | The web framework in use — see Frameworks below |
| `idempotency.enabled` | `boolean` | `false` | Enable the idempotency module |
| `idempotency.store` | `IdempotencyStore` | required | Storage backend — see Stores below |
| `idempotency.key` | `string` | `'Idempotency-Key'` | Request header name to read the idempotency key from |
| `idempotency.ttl` | `number` | `3600` | Seconds to retain completed responses |
| `idempotency.processingTtl` | `number` | `30` | Seconds the processing lock lives before auto-expiring |
| `idempotency.duplicateStrategy` | `'cache' \| 'reject'` | `'cache'` | What to do when a completed duplicate arrives |
| `idempotency.onStoreFailure` | `'strict' \| 'bypass'` | `'strict'` | What to do when the store throws |

---

## Frameworks

Pass `framework` to tell the library which adapter to use:

```typescript
import { Framework } from 'reliability-kit'

Framework.EXPRESS   // ✅ fully implemented
Framework.FASTIFY   // 🚧 planned
Framework.HONO      // 🚧 planned
Framework.KOA       // 🚧 planned
Framework.NEXTJS    // 🚧 planned
```

---

## Duplicate Strategies

### `cache` (default)

Returns the original response transparently. The caller cannot tell it was a duplicate.

```
POST /orders  { "Idempotency-Key": "abc123" }  →  201 { "id": "order_1" }
POST /orders  { "Idempotency-Key": "abc123" }  →  201 { "id": "order_1" }  ← cached, no re-execution
```

### `reject`

Explicitly rejects completed duplicates with a 409. Use when callers must be told they are retrying.

```
POST /orders  { "Idempotency-Key": "abc123" }  →  201 { "id": "order_1" }
POST /orders  { "Idempotency-Key": "abc123" }  →  409 { "error": "Duplicate request" }
```

---

## Failure Modes

### `strict` (default)

Any store error — on acquire, get, or set — throws and aborts the request. Use for payments, billing, or any operation that cannot safely execute twice.

### `bypass`

Store errors are swallowed and the request proceeds without idempotency protection. Use when idempotency is a nice-to-have but availability matters more than duplicate safety.

> ⚠️ In bypass mode without `acquire()`, any two concurrent requests can both execute the handler. Store errors are also swallowed silently. Only use bypass when duplicate execution is acceptable.

---

## Stores

### `MemoryStore`

In-process store backed by a `Map`. State is not shared across instances or server restarts.

```typescript
import { MemoryStore } from 'reliability-kit'

const store = new MemoryStore()
```

| | |
|---|---|
| ✅ Zero setup | ✅ Fast |
| ❌ Single instance only | ❌ Lost on restart |

**Use for:** local development, testing.

---

### `RedisStore`

Distributed store backed by Redis. Works correctly across multiple instances and server restarts (within Redis durability limits).

```typescript
import Redis from 'ioredis'
import { RedisStore } from 'reliability-kit'

const store = new RedisStore(new Redis())
```

| | |
|---|---|
| ✅ Distributed-safe | ✅ Handles concurrency atomically |
| ✅ Scales horizontally | ❌ In-memory — data lost if Redis restarts without persistence |

**Use for:** production, multi-instance deployments.

Atomicity is achieved via a single Redis command:

```
SET key value NX EX ttl
```

`NX` (set if not exists) guarantees only one request acquires the lock, even under concurrent load. This is not replicable with a plain `GET` + `SET`.

> **Important:** If you use Redis with a memory eviction policy (e.g. `allkeys-lru`), completed records can be evicted under memory pressure — the next retry will re-execute the handler. Use `maxmemory-policy noeviction` or a dedicated Redis instance for idempotency keys.

---

### Custom Store (BYOS)

Implement the `IdempotencyStore` interface to use any backend. The module routes to the correct execution path automatically based on whether your store implements `acquire()`.

#### With `acquire()` — full concurrency safety

Use this for any backend that supports a conditional write. The module uses the locked path — only one request executes the handler per key.

```typescript
import type { IdempotencyStore, IdempotencyRecord } from 'reliability-kit'

class PostgresStore implements IdempotencyStore {
  /**
   * Atomically writes a processing lock.
   * Returns true  → this request won the race, proceed with the handler.
   * Returns false → key already exists, another request holds it.
   *
   * The database constraint handles the race — no Lua scripts needed.
   */
  async acquire(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.db.query(`
      INSERT INTO idempotency_keys (key, status, expires_at)
      VALUES ($1, 'processing', now() + ($2 || ' seconds')::interval)
      ON CONFLICT (key) DO NOTHING
    `, [key, ttlSeconds])

    // rowCount > 0 → INSERT succeeded, this request won
    // rowCount === 0 → ON CONFLICT fired, key already existed
    return result.rowCount > 0
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const result = await this.db.query(`
      SELECT status, response, status_code
      FROM idempotency_keys
      WHERE key = $1 AND expires_at > now()
    `, [key])

    const row = result.rows[0]
    if (!row || row.status !== 'completed') return null

    return {
      status: 'completed',
      response: row.response,
      statusCode: row.status_code,
    }
  }

  async set(key: string, value: IdempotencyRecord, ttlSeconds?: number): Promise<void> {
    await this.db.query(`
      UPDATE idempotency_keys
      SET status = 'completed', response = $2, status_code = $3,
          expires_at = now() + ($4 || ' seconds')::interval
      WHERE key = $1
    `, [key, JSON.stringify(value.response), value.statusCode ?? 200, ttlSeconds ?? 3600])
  }

  /**
   * Optional but recommended — releases the lock immediately when the
   * handler throws, so retries don't wait for processingTtl to expire.
   * The WHERE clause makes this atomic — never wipes a completed record.
   */
  async release(key: string): Promise<void> {
    await this.db.query(`
      DELETE FROM idempotency_keys
      WHERE key = $1 AND status = 'processing'
    `, [key])
  }

  async delete(key: string): Promise<void> {
    await this.db.query(`DELETE FROM idempotency_keys WHERE key = $1`, [key])
  }
}
```

The same `acquire()` pattern works for other backends:

```typescript
// DynamoDB — ConditionExpression attribute_not_exists
async acquire(key, ttl): Promise<boolean> {
  try {
    await dynamo.putItem({
      ConditionExpression: 'attribute_not_exists(#key)',
      // ...
    })
    return true   // won
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false  // lost
    throw err
  }
}

// MongoDB — $setOnInsert with upsert
async acquire(key, ttl): Promise<boolean> {
  const result = await collection.findOneAndUpdate(
    { key },
    { $setOnInsert: { key, status: 'processing' } },
    { upsert: true, returnDocument: 'before' }
  )
  return result === null  // null = document didn't exist = we won
}
```

---

#### Without `acquire()` — best-effort only

For operations that are safe to execute more than once — analytics, reads, or low-traffic non-critical writes. The module uses the simple path: `get → execute → set`. No concurrency guarantee.

```typescript
class SimpleStore implements IdempotencyStore {
  // No acquire() — best-effort idempotency
  async get(key: string): Promise<IdempotencyRecord | null> { ... }
  async set(key: string, value: IdempotencyRecord, ttl?: number): Promise<void> { ... }
  async delete(key: string): Promise<void> { ... }
}

app.use(reliability({
  framework: Framework.EXPRESS,
  idempotency: {
    enabled: true,
    store: new SimpleStore(),
    onStoreFailure: 'bypass',  // required — strict mode throws without acquire()
  }
}))
```

> ⚠️ Without `acquire()`, two concurrent requests with the same key can both execute the handler. Only use this when that outcome is acceptable.

---

### Required SQL migration

```sql
CREATE TABLE idempotency_keys (
  key         TEXT        PRIMARY KEY,  -- unique constraint = atomic acquire
  status      TEXT        NOT NULL CHECK (status IN ('processing', 'completed')),
  response    JSONB,
  status_code INT,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- for filtering expired records and cleanup job
CREATE INDEX idx_idempotency_expires_at ON idempotency_keys (expires_at);
```

Run periodically to clean up expired records (pg_cron or external cron):

```sql
DELETE FROM idempotency_keys WHERE expires_at < now();
```

---

## TTL Trade-offs

Two separate TTLs serve different purposes:

| TTL | Purpose | What happens when it expires |
|---|---|---|
| `processingTtl` | Limits how long a processing lock lives | Lock auto-expires — retries can re-acquire and re-execute |
| `ttl` | How long completed responses are cached | Record deleted — next request is treated as new and re-executes |

**`processingTtl` is your safety net.** If the handler crashes between `acquire()` and `set()` — before the response is stored — the lock expires after `processingTtl` seconds. The next retry re-acquires and runs the handler again. Set this higher than your p99 handler latency to avoid false expiry under load.

**`ttl` is your deduplication window.** Requests arriving with the same key within this window get the cached response. Requests arriving after it re-execute. Set this to match your clients' retry window — typically 24 hours for payment flows.

> `processingTtl` must always be less than `ttl`. The library enforces this at startup and throws a `ReliabilityValidationError` if violated.

---

## Concurrency

When two requests with the same key arrive simultaneously:

```
Request A: acquire() → 'OK'    ← wins, proceeds to handler
Request B: acquire() → null    ← loses, checks store
                                  status = 'processing' → 409 { retryAfter: 30 }
```

Request B receives a `Retry-After` header telling it the earliest safe time to retry. The module does not poll or retry internally — that is the caller's responsibility.

```
HTTP/1.1 409 Conflict
Retry-After: 30
{ "error": "Request already in progress", "retryAfter": 30 }
```

---

## Configuration Errors

Invalid configuration throws a `ReliabilityValidationError` at startup with all problems listed at once — so you fix everything in one go rather than discovering errors one by one.

```typescript
import { ReliabilityValidationError } from 'reliability-kit'

try {
  app.use(reliability(options))
} catch (err) {
  if (err instanceof ReliabilityValidationError) {
    err.errors.forEach(e => console.error(`[${e.code}] ${e.message}`))
  }
}
```

| Error Code | Cause |
|---|---|
| `IDEMPOTENCY_STORE_REQUIRED` | `store` is missing when `enabled: true` |
| `IDEMPOTENCY_TTL_MUST_BE_POSITIVE` | `ttl` is 0 or negative |
| `IDEMPOTENCY_PROCESSING_TTL_MUST_BE_POSITIVE` | `processingTtl` is 0 or negative |
| `IDEMPOTENCY_PROCESSING_TTL_EXCEEDS_TTL` | `processingTtl` is greater than or equal to `ttl` |

If your store does not implement `acquire()` and `onStoreFailure` is `'strict'`, the module also throws at construction time with a message that explains how to implement `acquire()` for your backend.

---

## Important Notes

### `acquire()` is the concurrency primitive

`acquire()` is what separates safe idempotency from best-effort. Without it, two concurrent requests can both pass the `get()` check simultaneously:

```
Request A: get() → null → execute ✅
Request B: get() → null → execute ✅  ← duplicate execution
```

Implement `acquire()` using whatever conditional write your backend supports:

| Backend | Primitive |
|---|---|
| Redis | `SET key value NX EX ttl` |
| SQL | `INSERT ON CONFLICT DO NOTHING` |
| DynamoDB | `ConditionExpression: attribute_not_exists` |
| MongoDB | `findOneAndUpdate` with `$setOnInsert` |
| Memory | `Map.has() + Map.set()` (single-threaded atomic) |

---

### `release()` vs `delete()`

Both remove a key, but they behave differently:

- `release()` — only deletes if the record is still `processing`. Safe to call unconditionally — will never wipe a completed record.
- `delete()` — unconditional. Used for admin/cleanup only, never in error recovery paths.

Always use `release()` in your store's error recovery. If you call `delete()` after `set()` has already completed, you wipe the cached response and the next retry re-executes the handler.

---

### Large responses

Completed responses are serialized and stored in full. For large payloads — file uploads, bulk results — store a reference instead of the payload itself:

```typescript
// ❌ storing a 5MB response body in Redis
ctx.response = { data: hugeArray }

// ✅ storing a reference
ctx.response = { id: 'result_abc123', url: '/results/abc123' }
```

---

## Quick Reference

| Environment | Recommended Store |
|---|---|
| Local development | `MemoryStore` |
| Production (single instance) | `MemoryStore` or `RedisStore` |
| Production (multi-instance) | `RedisStore` |
| Payments / irreversible ops | Custom SQL store with `acquire()` |
| Analytics / low-risk ops | Custom store without `acquire()` + `bypass` mode |

---

## One-line takeaway

Same key = same result, no matter how many times the request is sent.