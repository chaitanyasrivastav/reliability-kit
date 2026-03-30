# @reliability-tools/core

Framework-agnostic reliability engine for Node.js. Provides the idempotency module and pluggable store interface used by `@reliability-tools/express` and `@reliability-tools/fastify`.

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

// run the engine — ctx.response and ctx.statusCode are set after execution
await engine.execute(ctx, async () => {
  ctx.response = await yourHandler(request)
  ctx.statusCode = 201
})

// map ctx back to your framework's response
reply.status(ctx.statusCode ?? 200).send(ctx.response)
```

---

## Idempotency Module

Prevents duplicate execution of request handlers using atomic locking. Same request, same result, no matter how many times it is sent.

- Atomic locking via Redis `SET NX EX` or Node.js single-threaded guarantees
- Pluggable store interface — bring your own Redis, SQL, DynamoDB, or custom backend
- Best-effort mode for stores without `acquire()` — no lock needed
- Fingerprint validation — detects key reuse across different requests
- Configurable duplicate strategies (`cache` or `reject`)
- Configurable failure modes (`strict` or `bypass`)
- `Retry-After` header on in-progress responses

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

## Error Handling

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

`ReliabilityValidationError` is thrown at construction time for invalid configuration — never during a live request.

---

## Zero Runtime Dependencies

No runtime dependencies. Bring your own Redis client and framework.

---

## License

MIT
