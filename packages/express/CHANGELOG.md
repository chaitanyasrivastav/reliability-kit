# @reliability-tools/express

# Changelog

## 0.3.1 — 2026-03-30

### Added

- Initial public release on npm
- Idempotency middleware with MemoryStore and RedisStore support
- Fingerprint validation — detects key reuse across different requests
  - Three strategies: `method` (default), `method+path`, `full`
  - Returns `422` on fingerprint mismatch
- Configurable duplicate strategies: `cache` (return cached response) or `reject` (409)
- Configurable failure modes: `strict` (throw) or `bypass` (degrade gracefully)
- `Retry-After` header on in-progress `409` responses
- Full ESM and CommonJS support

## 0.3.0 — 2026-03-24

### Changed

- Refactored into monorepo — core logic moved to `@reliability-tools/core`
- Import path changed:
  ```ts
  // before
  import { reliability } from 'reliability-kit'
  // after
  import { reliability } from '@reliability-tools/express' // or @reliability-tools/fastify
  ```

## 0.2.2 — 2026-03-23

### Fixed

- Express adapter: guard `res.send` from overwriting `ctx.response` already captured by `res.json` — prevents cached responses from being double-serialized
- Redis persistence of fingerprint alongside cached response

## 0.2.1 — 2026-03-22

### Fixed

- Suppressed false-positive ESLint `no-explicit-any` warning on Redis client interface

## 0.2.0 — 2026-03-22

### Added

- Fastify adapter — per-route wrapper function pattern
- Fingerprint validation with three strategies: `method`, `method+path`, `full`
- `fingerprintStrategy` config option
- `fingerprint` field on `IdempotencyRecord`

### Fixed

- Express adapter: use `req.url` instead of `req.path` so query string is included in fingerprint

### Migration — SQL stores only

```sql
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS fingerprint TEXT;
```
