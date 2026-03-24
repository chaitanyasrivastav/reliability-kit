# reliability-kit

API reliability toolkit for Node.js — idempotency, and more coming soon.

Prevents duplicate executions in distributed systems. Same request, same result, no matter how many times it is sent.

---

## Install

```bash
npm install @reliability/express
# or
npm install @reliability/fastify
```

Supports both CommonJS and ESM.

```typescript
// ESM
import { reliability } from '@reliability/express'

// CommonJS
const { reliability } = require('@reliability/express')
```

---

## Quick Start

### Express

```typescript
import express from 'express'
import { reliability, MemoryStore } from '@reliability/express'

const app = express()
app.use(express.json())

app.use(
  reliability({
    idempotency: {
      enabled: true,
      store: new MemoryStore(), // use RedisStore in production
    },
  }),
)

app.post('/orders', (req, res) => {
  res.status(201).json({ id: 'order_1', created: true })
})

app.listen(3000)
```

### Fastify

```typescript
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

Use `RedisStore` in production — it works correctly across multiple instances and server restarts.

### Express

```typescript
import { reliability, RedisStore } from '@reliability/express'
import Redis from 'ioredis'

app.use(
  reliability({
    idempotency: {
      enabled: true,
      store: new RedisStore(new Redis()),
      ttl: 86400, // cache responses for 24 hours
      processingTtl: 30, // lock expires after 30s if process crashes
      duplicateStrategy: 'cache',
      onStoreFailure: 'strict',
      fingerprintStrategy: 'full', // validates method + path + body
    },
  }),
)
```

### Fastify

```typescript
import { reliability, RedisStore } from '@reliability/fastify'
import Redis from 'ioredis'

const protect = reliability({
  idempotency: {
    enabled: true,
    store: new RedisStore(new Redis()),
    ttl: 86400,
    processingTtl: 30,
    duplicateStrategy: 'cache',
    onStoreFailure: 'strict',
    fingerprintStrategy: 'full', // validates method + path + body
  },
})

fastify.post('/orders', protect(createOrderHandler))
fastify.post('/payments', protect(createPaymentHandler))
fastify.get('/health', healthHandler) // ← unwrapped, no idempotency
```

---

## Modules

### Idempotency

Prevents duplicate execution of request handlers. Built for payment flows, order creation, email sending — any operation that must not run twice.

- Atomic locking via Redis `SET NX EX` or Node.js single-threaded guarantees
- Pluggable store interface — bring your own Redis, SQL, DynamoDB, or custom backend
- Best-effort mode for stores without `acquire()` — no lock needed
- Fingerprint validation — detects key reuse across different requests (`method`, `method+path`, `full`)
- Configurable duplicate strategies (`cache` or `reject`)
- Configurable failure modes (`strict` or `bypass`)
- `Retry-After` header on in-progress responses

→ [Full documentation](./docs/idempotency.md)

---

## Stores

| Store                      | Use for                                           |
| -------------------------- | ------------------------------------------------- |
| `MemoryStore`              | Local development, testing                        |
| `RedisStore`               | Production, multi-instance deployments            |
| Custom with `acquire()`    | SQL, DynamoDB, MongoDB — full concurrency safety  |
| Custom without `acquire()` | Analytics, reads, low-risk ops — best-effort only |

---

## Frameworks

| Framework           | Status           | Pattern                                     |
| ------------------- | ---------------- | ------------------------------------------- |
| `Framework.EXPRESS` | ✅ Supported     | Global, per-router, or per-route middleware |
| `Framework.FASTIFY` | ✅ Supported     | Per-route wrapper function                  |
| `Framework.HONO`    | 🚧 To Be Planned | —                                           |
| `Framework.KOA`     | 🚧 To Be Planned | —                                           |
| `Framework.NEXTJS`  | 🚧 To Be Planned | —                                           |

---

## Configuration Errors

Misconfiguration throws a `ReliabilityValidationError` at startup — not during a live request:

```typescript
import { ReliabilityValidationError } from '@reliability/core'
import { reliability } from '@reliability/fastify'

try {
  app.use(reliability(options))
} catch (err) {
  if (err instanceof ReliabilityValidationError) {
    err.errors.forEach((e) => console.error(`[${e.code}] ${e.message}`))
  }
}
```

---

## Zero Dependencies

reliability-kit has no runtime dependencies. Bring your own Redis client (ioredis, node-redis) and framework — any client that satisfies the minimal interface will work.

---

## License

MIT
