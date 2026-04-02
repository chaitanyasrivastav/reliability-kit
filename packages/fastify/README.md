# @reliability-tools/fastify

Idempotency wrapper for Fastify. Prevents duplicate execution of request handlers — built for payment flows, order creation, and any operation that must not run twice.

Full Documentation: https://github.com/chaitanyasrivastav/reliability-kit/tree/main/docs/idempotency.md

Per-route wrapper pattern — explicit opt-in per handler, no global middleware. Part of the [reliability-kit](https://github.com/chaitanyasrivastav/reliability-kit) monorepo.

---

## Install

```bash
npm install @reliability-tools/fastify
```

Requires Fastify as a peer dependency:

```bash
npm install fastify
```

---

## Quick Start

```ts
import Fastify from 'fastify'
import { reliability, MemoryStore } from '@reliability-tools/fastify'

const fastify = Fastify()

const protect = reliability({
  idempotency: {
    enabled: true,
    store: new MemoryStore(), // use RedisStore in production
  },
})

// wrap individual routes — explicit per-route control
fastify.post(
  '/orders',
  protect(async (request, reply) => {
    reply.status(201).send({ id: 'order_1', created: true })
  }),
)

fastify.listen({ port: 3000 })
```

```bash
# first request — handler executes
curl -X POST http://localhost:3000/orders \
  -H "Idempotency-Key: abc123" \
  -H "Content-Type: application/json"
# → 201 { "id": "order_1", "created": true }

# duplicate — cached response, handler never runs again
curl -X POST http://localhost:3000/orders \
  -H "Idempotency-Key: abc123" \
  -H "Content-Type: application/json"
# → 201 { "id": "order_1", "created": true }
#   Idempotency-Replayed: true
```

---

## Production Setup

```ts
import { reliability, RedisStore } from '@reliability-tools/fastify'
import Redis from 'ioredis'

const protect = reliability({
  idempotency: {
    enabled: true,
    store: new RedisStore(new Redis()),
    ttl: 86400, // cache responses for 24 hours
    processingTtl: 30, // lock expires after 30s if process crashes
    duplicateStrategy: 'cache',
    onStoreFailure: 'strict',
    fingerprintStrategy: 'full', // validates method + path + body
  },
})

fastify.post('/orders', protect(createOrderHandler))
fastify.post('/payments', protect(createPaymentHandler))
fastify.get('/health', healthHandler) // unwrapped — no idempotency
```

---

## Configuration

| Option                | Type                                  | Default    | Description                                      |
| --------------------- | ------------------------------------- | ---------- | ------------------------------------------------ |
| `store`               | `IdempotencyStore`                    | —          | Required. Storage backend                        |
| `ttl`                 | `number`                              | `3600`     | Seconds to cache completed responses             |
| `processingTtl`       | `number`                              | `30`       | Lock TTL in seconds — expires if process crashes |
| `duplicateStrategy`   | `'cache' \| 'reject'`                 | `'cache'`  | Return cached response or 409 on duplicate       |
| `onStoreFailure`      | `'strict' \| 'bypass'`                | `'strict'` | Throw or bypass idempotency on store errors      |
| `fingerprintStrategy` | `'method' \| 'method+path' \| 'full'` | `'method'` | How strictly to validate key reuse               |

### Fingerprint strategies

| Strategy      | Validates                               | Use for                             |
| ------------- | --------------------------------------- | ----------------------------------- |
| `method`      | HTTP method only                        | General use, zero overhead          |
| `method+path` | Method + normalized path + query string | REST APIs with path-based resources |
| `full`        | Method + path + request body            | Payment flows, order creation       |

Fingerprint mismatch returns `422` with `{ error: 'idempotency_key_mismatch' }`.

---

## Response Headers

| Header                       | When set                  | Description                                             |
| ---------------------------- | ------------------------- | ------------------------------------------------------- |
| `Idempotency-Replayed: true` | Cached response served    | Signals the response was replayed, not freshly computed |
| `Retry-After: <seconds>`     | Request in progress (409) | How long to wait before retrying                        |

---

## Error Codes

All errors use machine-readable codes clients can switch on:

| Code                       | Status | Description                                                        |
| -------------------------- | ------ | ------------------------------------------------------------------ |
| `invalid_idempotency_key`  | 422    | Key exceeds 255 characters or contains invalid characters          |
| `idempotency_key_in_use`   | 409    | A request with this key is already in progress                     |
| `idempotency_key_mismatch` | 422    | Key was reused with a different request — use a new key            |
| `duplicate_request`        | 409    | Request already completed and `duplicateStrategy: 'reject'` is set |

---

## Stores

| Store                      | Use for                                                   |
| -------------------------- | --------------------------------------------------------- |
| `MemoryStore`              | Local development and testing                             |
| `RedisStore`               | Production — works across multiple instances and restarts |
| Custom with `acquire()`    | SQL, DynamoDB, MongoDB — full concurrency safety          |
| Custom without `acquire()` | Low-risk ops — best-effort only, no concurrency guarantee |

### Custom store interface

```ts
interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>
  set(key: string, value: IdempotencyRecord, ttlSeconds?: number): Promise<void>
  delete(key: string): Promise<void>
  acquire?(key: string, ttl?: number): Promise<boolean> // optional — enables atomic locking
  release?(key: string): Promise<void>
}
```

---

## Startup Validation

Misconfiguration throws `ReliabilityValidationError` at startup — not during a live request:

```ts
import { ReliabilityValidationError } from '@reliability-tools/core'
import { reliability } from '@reliability-tools/fastify'

try {
  const protect = reliability(options)
} catch (err) {
  if (err instanceof ReliabilityValidationError) {
    err.errors.forEach((e) => console.error(`[${e.code}] ${e.message}`))
  }
}
```

---

## ESM and CommonJS

```ts
// ESM
import { reliability, MemoryStore, RedisStore } from '@reliability-tools/fastify'

// CommonJS
const { reliability, MemoryStore, RedisStore } = require('@reliability-tools/fastify')
```

---

## Zero Runtime Dependencies

No runtime dependencies beyond `@reliability-tools/core`. Bring your own Redis client — any client satisfying the minimal store interface will work.

---

## License

MIT
