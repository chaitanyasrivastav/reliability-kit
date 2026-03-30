# @reliability/fastify

Idempotency wrapper for Fastify. Prevents duplicate execution of request handlers — built for payment flows, order creation, and any operation that must not run twice.

Per-route wrapper pattern — explicit opt-in per handler, no global middleware. Part of the [reliability-kit](https://github.com/chaitanyasrivastav/reliability-kit) monorepo.

---

## Install

```bash
npm install @reliability/fastify
```

Requires Fastify as a peer dependency:

```bash
npm install fastify
```

---

## Quick Start

```ts
import Fastify from 'fastify'
import { reliability, MemoryStore } from '@reliability/fastify'

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
```

---

## Production Setup

```ts
import { reliability, RedisStore } from '@reliability/fastify'
import Redis from 'ioredis'

const protect = reliability({
  idempotency: {
    enabled: true,
    store: new RedisStore(new Redis()),
    ttl: 86400,           // cache responses for 24 hours
    processingTtl: 30,    // lock expires after 30s if process crashes
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

| Option | Type | Default | Description |
|---|---|---|---|
| `store` | `IdempotencyStore` | — | Required. Storage backend |
| `ttl` | `number` | `3600` | Seconds to cache completed responses |
| `processingTtl` | `number` | `30` | Lock TTL in seconds — expires if process crashes |
| `duplicateStrategy` | `'cache' \| 'reject'` | `'cache'` | Return cached response or 409 on duplicate |
| `onStoreFailure` | `'strict' \| 'bypass'` | `'strict'` | Throw or bypass idempotency on store errors |
| `fingerprintStrategy` | `'method' \| 'method+path' \| 'full'` | `'method'` | How strictly to validate key reuse |

### Fingerprint strategies

| Strategy | Validates | Use for |
|---|---|---|
| `method` | HTTP method only | General use, zero overhead |
| `method+path` | Method + normalized path + query string | REST APIs with path-based resources |
| `full` | Method + path + request body | Payment flows, order creation |

Fingerprint mismatch returns `422 Unprocessable Entity`.

---

## Stores

| Store | Use for |
|---|---|
| `MemoryStore` | Local development and testing |
| `RedisStore` | Production — works across multiple instances and restarts |
| Custom with `acquire()` | SQL, DynamoDB, MongoDB — full concurrency safety |
| Custom without `acquire()` | Low-risk ops — best-effort only, no concurrency guarantee |

### Custom store interface

```ts
interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>
  set(key: string, value: IdempotencyRecord, ttlSeconds?: number): Promise<void>
  delete(key: string): Promise<void>
  acquire?(key: string, ttl?: number): Promise<boolean>  // optional — enables atomic locking
  release?(key: string): Promise<void>
}
```

---

## Error Handling

Misconfiguration throws `ReliabilityValidationError` at startup — not during a live request:

```ts
import { ReliabilityValidationError } from '@reliability/core'
import { reliability } from '@reliability/fastify'

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
import { reliability, MemoryStore, RedisStore } from '@reliability/fastify'

// CommonJS
const { reliability, MemoryStore, RedisStore } = require('@reliability/fastify')
```

---

## Zero Runtime Dependencies

reliability-kit has no runtime dependencies beyond `@reliability/core`. Bring your own Redis client — any client satisfying the minimal store interface will work.

---

## License

MIT