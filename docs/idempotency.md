# Idempotency Module

Ensures that duplicate requests with the same key are processed only once — preventing double charges, duplicate orders, or repeated side effects in distributed systems.

---

## Installation

```bash
npm install @reliability-tools/express
# or
npm install @reliability-tools/fastify
```

Supports both CommonJS (`require`) and ESM (`import`).

```typescript
// ESM
import { reliability } from '@reliability-tools/express'

// CommonJS
const { reliability } = require('@reliability-tools/express')
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
            completed ──► validateFingerprint()
                               │
                           mismatch ──► 422
                           match    ──► cached response (or 409 reject)
            processing ──► 409 in-progress + Retry-After
```

**Phase 1 — Acquire:** Atomically write a `processing` lock. Only one concurrent request wins. All others get 409 immediately.

**Phase 2 — Execute:** Run the handler. If it throws, release the lock immediately so retries don't wait for the lock to expire.

**Phase 3 — Store:** Persist the response and fingerprint as `completed`. Future duplicates are validated and served from cache without re-executing the handler.

---

### Simple path — store does not implement `acquire()`

Used for stores without a conditional write primitive. Best-effort only — bypass mode required. Suitable for analytics, reads, or low-risk operations where occasional duplicate execution is acceptable.

```
get() ──► null ──► next() ──► set()   no concurrency guarantee
    │
 completed ──► validateFingerprint() ──► cached response (or 409 reject)
```

> ⚠️ Without `acquire()`, concurrent duplicate requests may both pass the `get()` check simultaneously and both execute the handler. Only use this path when that outcome is acceptable.

---

## Setup

### Express — global (all routes)

Apply as middleware on the entire app — every route is automatically protected. Requests without an `Idempotency-Key` header pass through without idempotency checks.

```typescript
import express from 'express'
import { reliability, RedisStore } from '@reliability-tools/express'
import Redis from 'ioredis'

const app = express()
app.use(express.json())

app.use(
  reliability({
    idempotency: {
      enabled: true,
      store: new RedisStore(new Redis()),
      key: 'Idempotency-Key', // header to read the key from
      ttl: 3600, // how long to cache completed responses (seconds)
      processingTtl: 30, // how long the processing lock lives (seconds)
      duplicateStrategy: 'cache', // 'cache' | 'reject'
      onStoreFailure: 'strict', // 'strict' | 'bypass'
      fingerprintStrategy: 'method', // 'method' | 'method+path' | 'full'
    },
  }),
)
```

---

### Express — per router

Apply idempotency only to a specific router — useful when only some routes need protection.

```typescript
import express from 'express'
import { reliability, MemoryStore } from '@reliability-tools/express'

const store = new RedisStore(new Redis())

// ── Protected router — idempotency enabled ─────────────────────────────
const ordersRouter = express.Router()

ordersRouter.use(
  reliability({
    idempotency: { enabled: true, store, ttl: 86400 },
  }),
)

ordersRouter.post('/', createOrderHandler)
ordersRouter.post('/cancel', cancelOrderHandler)

app.use('/orders', ordersRouter)

// ── Unprotected routes — no idempotency ───────────────────────────────
app.get('/health', healthHandler) // ← not protected
app.get('/products', listProducts) // ← not protected
```

---

### Express — per route

Apply idempotency to individual routes by passing it as middleware inline.

```typescript
const idempotency = reliability({
  idempotency: { enabled: true, store },
})

app.post('/orders', idempotency, createOrderHandler) // ← protected
app.post('/payments', idempotency, createPaymentHandler) // ← protected
app.get('/orders', listOrdersHandler) // ← not protected
```

---

### Fastify — per route (wrapper function)

The Fastify adapter returns a **wrapper function** instead of middleware. Apply it per route — only routes you wrap get idempotency protection.

```typescript
import Fastify from 'fastify'
import { reliability, RedisStore } from '@reliability-tools/fastify'
import Redis from 'ioredis'

const fastify = Fastify()

const protect = reliability({
  idempotency: {
    enabled: true,
    store: new RedisStore(new Redis()),
    ttl: 3600,
    processingTtl: 30,
    duplicateStrategy: 'cache',
    onStoreFailure: 'strict',
  },
})

fastify.post('/orders', protect(createOrderHandler))
fastify.post('/payments', protect(createPaymentHandler))
fastify.get('/health', healthHandler) // ← unwrapped, no idempotency
```

---

## Configuration

| Option                            | Type                                  | Default             | Description                                            |
| --------------------------------- | ------------------------------------- | ------------------- | ------------------------------------------------------ |
| `idempotency.enabled`             | `boolean`                             | `false`             | Enable the idempotency module                          |
| `idempotency.store`               | `IdempotencyStore`                    | required            | Storage backend — see Stores below                     |
| `idempotency.key`                 | `string`                              | `'Idempotency-Key'` | Request header name to read the idempotency key from   |
| `idempotency.ttl`                 | `number`                              | `3600`              | Seconds to retain completed responses                  |
| `idempotency.processingTtl`       | `number`                              | `30`                | Seconds the processing lock lives before auto-expiring |
| `idempotency.duplicateStrategy`   | `'cache' \| 'reject'`                 | `'cache'`           | What to do when a completed duplicate arrives          |
| `idempotency.onStoreFailure`      | `'strict' \| 'bypass'`                | `'strict'`          | What to do when the store throws                       |
| `idempotency.fingerprintStrategy` | `'method' \| 'method+path' \| 'full'` | `'method'`          | How strictly to validate duplicate requests            |

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

## Fingerprint Strategies

A fingerprint is stored alongside the response on first execution. On every subsequent duplicate, the incoming request is fingerprinted and compared. A mismatch means the client reused a key for a different request — rejected with 422.

### Why fingerprinting matters

Without fingerprinting, a client bug can silently return the wrong response:

```
GET  /payments  key: "1"  →  200 { "balance": 100 }  ← cached
POST /payments  key: "1"  →  200 { "balance": 100 }  ← WRONG — returns GET response
```

With fingerprinting (`method` strategy), the POST is rejected with 422 because the method changed.

### `method` (default)

Validates HTTP method only. Zero CPU cost — just a string comparison.

```
GET  /payments  key: "1"  →  200 { "balance": 100 }
POST /payments  key: "1"  →  422 { "error": "This idempotency key was used with a different request." }
```

**Use for:** internal services, trusted clients, low-risk operations.

### `method+path`

Validates method and path including query string. Trailing slash is stripped (`/orders/` = `/orders`). Query string is preserved as-is — param order is the client's responsibility.

SHA-256 of method + path for bounded storage size regardless of path length.

```
POST /orders   key: "1"  →  201 { "id": "order_1" }
POST /payments key: "1"  →  422 ← path changed
POST /orders?amount=100 key: "1"  →  201 { "id": "order_1" }
POST /orders?amount=999 key: "1"  →  422 ← query string changed
```

**Use for:** public APIs, multiple endpoints, untrusted clients.

### `full`

Validates method, path, query string, and request body. SHA-256 of all four. Any difference returns 422.

```
POST /payments  { amount: 100 }  key: "1"  →  201 { "id": "pay_1" }
POST /payments  { amount: 999 }  key: "1"  →  422 ← body changed
```

> ⚠️ `full` requires the request body to be parsed before the module runs. In Express, register `reliability()` **after** `express.json()`. In Fastify the wrapper runs after body parsing automatically.

**Use for:** payment flows, billing, any operation where body integrity must be guaranteed.

### Performance comparison

| Strategy      | Cost                                    | What it validates                   |
| ------------- | --------------------------------------- | ----------------------------------- |
| `method`      | Zero — string comparison                | HTTP method                         |
| `method+path` | ~1μs — SHA-256 of method + path         | Method + path + query string        |
| `full`        | ~50μs — SHA-256 of method + path + body | Method + path + query string + body |

### Backward compatibility

Records written before fingerprinting was introduced (v0.1.x) have no stored fingerprint. The module skips validation for these records gracefully — no 422 errors after upgrading.

---

## Stores

### `MemoryStore`

In-process store backed by a `Map`. State is not shared across instances or server restarts.

```typescript
import { MemoryStore } from '@reliability-tools/express'

const store = new MemoryStore()
```

|                         |                    |
| ----------------------- | ------------------ |
| ✅ Zero setup           | ✅ Fast            |
| ❌ Single instance only | ❌ Lost on restart |

**Use for:** local development, testing.

---

### `RedisStore`

Distributed store backed by Redis. Works correctly across multiple instances and server restarts (within Redis durability limits).

```typescript
import { RedisStore } from '@reliability-tools/express'
import Redis from 'ioredis'

const store = new RedisStore(new Redis())
```

|                        |                                                                |
| ---------------------- | -------------------------------------------------------------- |
| ✅ Distributed-safe    | ✅ Handles concurrency atomically                              |
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
const { IdempotencyStore, IdempotencyRecord } = require('@reliability-tools/core')

class PostgresStore implements IdempotencyStore {
  /**
   * Atomically writes a processing lock.
   * Returns true  → this request won the race, proceed with the handler.
   * Returns false → key already exists, another request holds it.
   *
   * The database constraint handles the race — no Lua scripts needed.
   */
  async acquire(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.db.query(
      `
      INSERT INTO idempotency_keys (key, status, expires_at)
      VALUES ($1, 'processing', now() + ($2 || ' seconds')::interval)
      ON CONFLICT (key) DO NOTHING
    `,
      [key, ttlSeconds],
    )

    // rowCount > 0 → INSERT succeeded, this request won
    // rowCount === 0 → ON CONFLICT fired, key already existed
    return result.rowCount > 0
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const result = await this.db.query(
      `
      SELECT status, response, status_code, fingerprint
      FROM idempotency_keys
      WHERE key = $1 AND expires_at > now()
    `,
      [key],
    )

    const row = result.rows[0]
    if (!row || row.status !== 'completed') return null

    return {
      status: 'completed',
      response: row.response,
      statusCode: row.status_code,
      fingerprint: row.fingerprint,
    }
  }

  async set(key: string, value: IdempotencyRecord, ttlSeconds?: number): Promise<void> {
    await this.db.query(
      `
      UPDATE idempotency_keys
      SET status = 'completed', response = $2, status_code = $3,
          fingerprint = $4,
          expires_at = now() + ($5 || ' seconds')::interval
      WHERE key = $1
    `,
      [
        key,
        JSON.stringify(value.response),
        value.statusCode ?? 200,
        value.fingerprint ?? null,
        ttlSeconds ?? 3600,
      ],
    )
  }

  /**
   * Optional but recommended — releases the lock immediately when the
   * handler throws, so retries don't wait for processingTtl to expire.
   * The WHERE clause makes this atomic — never wipes a completed record.
   */
  async release(key: string): Promise<void> {
    await this.db.query(
      `
      DELETE FROM idempotency_keys
      WHERE key = $1 AND status = 'processing'
    `,
      [key],
    )
  }

  async delete(key: string): Promise<void> {
    await this.db.query(`DELETE FROM idempotency_keys WHERE key = $1`, [key])
  }
}
```

The same `acquire()` pattern works for other backends:

```typescript
// DynamoDB — ConditionExpression attribute_not_exists
async acquire(key: string, ttl: number): Promise<boolean> {
  try {
    await dynamo.putItem({
      ConditionExpression: 'attribute_not_exists(#key)',
      // ...
    })
    return true   // won
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') return false  // lost
    throw err
  }
}

// MongoDB — $setOnInsert with upsert
async acquire(key: string, ttl: number): Promise<boolean> {
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
  key         TEXT        PRIMARY KEY,
  status      TEXT        NOT NULL CHECK (status IN ('processing', 'completed')),
  response    JSONB,
  status_code INT,
  fingerprint TEXT,                    -- added in v0.2.0
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_idempotency_expires_at ON idempotency_keys (expires_at);
```

**Upgrading from v0.1.x:** run this migration before deploying v0.2.0:

```sql
ALTER TABLE idempotency_keys
ADD COLUMN IF NOT EXISTS fingerprint TEXT;
```

Redis and Memory stores require no migration — the fingerprint is stored in the JSON payload automatically.

Run periodically to clean up expired records (pg_cron or external cron):

```sql
DELETE FROM idempotency_keys WHERE expires_at < now();
```

---

## TTL Trade-offs

Two separate TTLs serve different purposes:

| TTL             | Purpose                                 | What happens when it expires                                    |
| --------------- | --------------------------------------- | --------------------------------------------------------------- |
| `processingTtl` | Limits how long a processing lock lives | Lock auto-expires — retries can re-acquire and re-execute       |
| `ttl`           | How long completed responses are cached | Record deleted — next request is treated as new and re-executes |

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
import { ReliabilityValidationError } from '@reliability-tools/core'

try {
  app.use(reliability(options))
} catch (err) {
  if (err instanceof ReliabilityValidationError) {
    err.errors.forEach((e) => console.error(`[${e.code}] ${e.message}`))
  }
}
```

| Error Code                                    | Cause                                             |
| --------------------------------------------- | ------------------------------------------------- |
| `IDEMPOTENCY_STORE_REQUIRED`                  | `store` is missing when `enabled: true`           |
| `IDEMPOTENCY_TTL_MUST_BE_POSITIVE`            | `ttl` is 0 or negative                            |
| `IDEMPOTENCY_PROCESSING_TTL_MUST_BE_POSITIVE` | `processingTtl` is 0 or negative                  |
| `IDEMPOTENCY_PROCESSING_TTL_EXCEEDS_TTL`      | `processingTtl` is greater than or equal to `ttl` |

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

| Backend  | Primitive                                        |
| -------- | ------------------------------------------------ |
| Redis    | `SET key value NX EX ttl`                        |
| SQL      | `INSERT ON CONFLICT DO NOTHING`                  |
| DynamoDB | `ConditionExpression: attribute_not_exists`      |
| MongoDB  | `findOneAndUpdate` with `$setOnInsert`           |
| Memory   | `Map.has() + Map.set()` (single-threaded atomic) |

---

### Express vs Fastify adapter behaviour

|                      | Express                                        | Fastify                |
| -------------------- | ---------------------------------------------- | ---------------------- |
| Pattern              | Middleware                                     | Wrapper function       |
| Global scope         | `app.use(reliability(...))`                    | ❌ not supported       |
| Router scope         | `router.use(reliability(...))`                 | ❌ not supported       |
| Per-route            | `app.post('/path', reliability(...), handler)` | `protect(handler)`     |
| Opt-out on global    | Send no `Idempotency-Key` header               | —                      |
| Opt-out on per-route | Don't add middleware to that route             | Don't wrap the handler |

---

### Idempotency key uniqueness

The idempotency key must be unique per logical operation. The library does not namespace keys by method or path — that is the client's responsibility.

If a client reuses a key across different operations, the fingerprint validation catches the most common mistakes:

```
method        → catches wrong HTTP method
method+path   → catches wrong endpoint or query string
full          → catches wrong body
```

Keys are the client's namespace. Use a UUID v4 or similar per operation:

```typescript
const key = crypto.randomUUID() // unique per operation
```

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

| Environment                  | Recommended Store                           | Recommended Strategy |
| ---------------------------- | ------------------------------------------- | -------------------- |
| Local development            | `MemoryStore`                               | `method`             |
| Production (single instance) | `MemoryStore` or `RedisStore`               | `method`             |
| Production (multi-instance)  | `RedisStore`                                | `method+path`        |
| Payments / irreversible ops  | Custom SQL store with `acquire()`           | `full`               |
| Analytics / low-risk ops     | Custom store without `acquire()` + `bypass` | `method`             |

---

## One-line takeaway

Same key = same result, no matter how many times the request is sent.
