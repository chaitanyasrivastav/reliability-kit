# @reliability/express

Idempotency middleware for Express. Prevents duplicate execution of request handlers — built for payment flows, order creation, and any operation that must not run twice.

Supports Express 4 and 5. Part of the [reliability-kit](https://github.com/chaitanyasrivastav/reliability-kit) monorepo.

---

## Install

```bash
npm install @reliability/express
```

Requires Express as a peer dependency:

```bash
npm install express
```

---

## Quick Start

```ts
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
import { reliability, RedisStore } from '@reliability/express'
import Redis from 'ioredis'

app.use(
  reliability({
    idempotency: {
      enabled: true,
      store: new RedisStore(new Redis()),
      ttl: 86400,           // cache responses for 24 hours
      processingTtl: 30,    // lock expires after 30s if process crashes
      duplicateStrategy: 'cache',
      onStoreFailure: 'strict',
      fingerprintStrategy: 'full', // validates method + path + body
    },
  }),
)
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
import { reliability } from '@reliability/express'

try {
  app.use(reliability(options))
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
import { reliability, MemoryStore, RedisStore } from '@reliability/express'

// CommonJS
const { reliability, MemoryStore, RedisStore } = require('@reliability/express')
```

---

## Zero Runtime Dependencies

reliability-kit has no runtime dependencies beyond `@reliability/core`. Bring your own Redis client — any client satisfying the minimal store interface will work.

---

## License

MIT