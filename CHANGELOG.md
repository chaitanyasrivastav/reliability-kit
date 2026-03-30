## 0.3.0 — 2026-03-24

### Changed

- Refactored project into a monorepo structure with separate packages:
  - `@reliability-tools/core` — framework-agnostic engine and modules
  - `@reliability-tools/express` — Express adapter
  - `@reliability-tools/fastify` — Fastify adapter
- Decoupled core reliability engine from framework-specific implementations
- Adapters now depend on `@reliability-tools/core` instead of bundling all logic

### Breaking Changes

- Import paths have changed:
  - Before:
    ```ts
    import { reliability } from 'reliability-kit'
    ```
  - After:
    ```ts
    import { reliability } from '@reliability-tools/express'
    ```
- Core functionality is no longer available via a single package entrypoint

### Improved

- Reduced package size for framework-specific usage (install only what you need)
- Better separation of concerns between engine and adapters
- Foundation for adding future modules (circuit breaker, rate limiting, etc.) without bloating adapters

### Notes

- This release focuses on internal architecture changes and package distribution
- Recommended for early adopters; API may still evolve before `1.0.0`

## 0.2.2 — 2026-03-23

### Fixed

- Express adapter: guard `res.send` from overwriting `ctx.response` already
  captured by `res.json` — prevents cached responses from being
  double-serialized as a JSON string instead of a JSON object
- Redis persistence of fingerprint alongside cached response

## 0.2.1 — 2026-03-22

### Fixed

- Suppressed false-positive ESLint `no-explicit-any` warning on Redis client
  interface — `any` is intentional here due to the variadic SET command options

## 0.2.0 — 2026-03-22

### Added

- Fastify adapter — per-route wrapper function pattern, zero external dependencies
- Fingerprint validation — detect key reuse across different requests
  - Three strategies: 'method' (default), 'method+path', 'full'
  - 'method' — zero cost, catches wrong-method retries
  - 'method+path' — SHA-256 of method + normalized path + query string
  - 'full' — SHA-256 of method + path + body, recommended for payment flows
  - Returns 422 when fingerprint mismatches
  - Gracefully skips validation for records without a stored fingerprint (v0.1.x records)
- fingerprintStrategy config option on IdempotencyConfig
- fingerprint field on IdempotencyRecord

### Fixed

- Express adapter: use req.url instead of req.path so query string is included in fingerprint

### Migration

- SQL stores: run ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS fingerprint TEXT
- Redis and Memory stores: no changes required
