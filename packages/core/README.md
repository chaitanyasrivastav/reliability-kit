# @reliability-tools/core

Framework-agnostic reliability engine for Node.js. Provides the idempotency module and pluggable store interface used by `@reliability-tools/express` and `@reliability-tools/fastify`.

Full Documentation: https://github.com/chaitanyasrivastav/reliability-kit/tree/main/docs/idempotency.md

You typically don't install this directly — install the adapter for your framework instead. Use this package if you're building a custom adapter or integrating with an unsupported framework.

Part of the [reliability-kit](https://github.com/chaitanyasrivastav/reliability-kit) monorepo.

---

## Install

```bash
npm install @reliability-tools/core
```

---

## Framework Adapters

| Package                                                                                  | Framework       |
| ---------------------------------------------------------------------------------------- | --------------- |
| [`@reliability-tools/express`](https://www.npmjs.com/package/@reliability-tools/express) | Express 4 and 5 |
| [`@reliability-tools/fastify`](https://www.npmjs.com/package/@reliability-tools/fastify) | Fastify 5       |

---

## Building a Custom Adapter

Implement `RequestContext`, run the engine, and map the result back to your framework's response:

```ts
import { ReliabilityEngine, RequestContext } from '@reliability-tools/core'
import { IdempotencyModule, MemoryStore } from '@reliability-tools/core'

const engine = new ReliabilityEngine({
  idempotency: {
    enabled: true,
    store: new MemoryStore(),
  },
})

// map your framework's request to RequestContext
const ctx: RequestContext = {
  method: request.method,
  path: request.url,
  headers: request.headers,
  body: request.body,
}

// run the engine — ctx.response, ctx.statusCode, and ctx.responseHeaders
// are set after execution
await engine.handle(ctx, async () => {
  ctx.response = await yourHandler(request)
  ctx.statusCode = 201
})

// forward module-written response headers (Retry-After, Idempotency-Replayed, etc.)
for (const [key, value] of Object.entries(ctx.responseHeaders ?? {})) {
  reply.header(key, value)
}

// map ctx back to your framework's response
reply.status(ctx.statusCode ?? 200).send(ctx.response)
```

---

## Idempotency Module

Prevents duplicate execution of request handlers using atomic locking. Same request, same result, no matter how many times it is sent.

- Atomic locking via Redis `SET NX EX` or Node.js single-threaded guarantees
- Pluggable store interface — bring your own Redis, SQL, DynamoDB, or custom backend
- Best-effort mode for stores without `acquire()` — no lock needed
- RFC-compliant key validation — 255 character max, printable ASCII only
- Method filtering — only applies to `POST`, `PUT`, `PATCH` — naturally idempotent methods are skipped
- Key scoping per endpoint — same key on `/orders` and `/payments` are independent store entries
- Fingerprint validation — detects key reuse across different requests (`method`, `method+path`, `full`)
- Configurable duplicate strategies (`cache` or `reject`)
- Configurable failure modes (`strict` or `bypass`)
- `Retry-After` header on in-progress responses
- `Idempotency-Replayed: true` header on cached responses

---

## Store Interface

```ts
interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>
  set(key: string, value: IdempotencyRecord, ttlSeconds?: number): Promise<void>
  delete(key: string): Promise<void>
  acquire?(key: string, ttl?: number): Promise<boolean> // optional — enables atomic locking
  release?(key: string): Promise<void>
}
```

Stores with `acquire()` get full concurrency safety via atomic locking. Stores without it run in best-effort mode — two concurrent identical requests may both execute.

### Built-in stores

```ts
import { MemoryStore, RedisStore } from '@reliability-tools/core'

// development and testing
const store = new MemoryStore()

// production — pass any ioredis or node-redis compatible client
const store = new RedisStore(redisClient)
```

---

## Error Codes

All errors returned by the idempotency module use machine-readable codes:

| Code                       | Status | Description                                                        |
| -------------------------- | ------ | ------------------------------------------------------------------ |
| `invalid_idempotency_key`  | 422    | Key exceeds 255 characters or contains invalid characters          |
| `idempotency_key_in_use`   | 409    | A request with this key is already in progress                     |
| `idempotency_key_mismatch` | 422    | Key was reused with a different request — use a new key            |
| `duplicate_request`        | 409    | Request already completed and `duplicateStrategy: 'reject'` is set |

---

## Error Handling

Misconfiguration throws `ReliabilityValidationError` at startup — not during a live request:

```ts
import { ReliabilityValidationError } from '@reliability-tools/core'

try {
  const engine = new ReliabilityEngine(options)
} catch (err) {
  if (err instanceof ReliabilityValidationError) {
    err.errors.forEach((e) => console.error(`[${e.code}] ${e.message}`))
  }
}
```

---

## RequestContext

The contract between adapters and modules:

```ts
interface RequestContext {
  method: string
  path: string
  headers?: Record<string, string | string[] | undefined>
  body?: unknown
  statusCode?: number
  response?: unknown
  responseHeaders?: Record<string, string> // written by modules, forwarded by adapters
}
```

Modules read from `method`, `path`, `headers`, and `body`. They write to `statusCode`, `response`, and `responseHeaders`. Adapters are responsible for flushing those back to the framework.

---

## Zero Runtime Dependencies

No runtime dependencies. Bring your own Redis client and framework.

---

## License

MIT
