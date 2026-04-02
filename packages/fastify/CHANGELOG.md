# @reliability-tools/fastify

## 0.4.1

### Patch Changes

- Improve documentation and package metadata
  - add full documentation link at top of README
  - restructure README for better readability
  - refine package descriptions to focus on idempotency
  - add homepage, repository, bugs, and keywords to package.json

## 0.4.0

### Minor Changes

- RFC-compliant idempotency — key scoping per endpoint, method filtering,
  key validation, Idempotency-Replayed header, machine-readable error codes,
  ctx.responseHeaders separation

### Patch Changes

- Updated dependencies []:
  - @reliability-tools/core@0.4.0

# Changelog

## 0.3.1 — 2026-03-30

### Added

- Initial public release on npm
- Idempotency per-route wrapper with MemoryStore and RedisStore support
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
  import { reliability } from '@reliability-tools/fastify'
  ```

## 0.2.0 — 2026-03-22

### Added

- Fastify adapter — initial release, per-route wrapper function pattern
- Fingerprint validation with three strategies: `method`, `method+path`, `full`
- `fingerprintStrategy` config option
- `fingerprint` field on `IdempotencyRecord`

### Migration — SQL stores only

```sql
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS fingerprint TEXT;
```
