# @reliability-tools/core

## 0.4.2

### Patch Changes

- 0.4.2 — 2026-04-04

  Fixed
  • Enforced fingerprint validation for idempotency keys
  • Requests with the same key but different fingerprints now correctly return 422 Unprocessable Entity
  • Fixes cases where different routes or query variations were incorrectly treated as the same request

  Changed
  • Updated fingerprinting behavior for method+path strategy
  • Now consistently includes full request path (including query string) via req.originalUrl
  • Aligned middleware behavior with HTTP semantics
  • Idempotency handling is now skipped for safe methods like GET

  Improved
  • Re-exported MemoryStore, RedisStore, and ReliabilityValidationError from framework adapters (express, fastify)
  • Simplifies imports and improves developer experience
  • Corrected README examples to reflect proper import sources (@reliability-tools/core)

  Notes
  • This release improves correctness under concurrent and mismatched request scenarios
  • No breaking API changes, but stricter validation may surface previously unnoticed issues in incorrect integrations

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

# Changelog

## 0.3.1 — 2026-03-30

### Added

- Initial public release on npm
- Framework-agnostic `ReliabilityEngine` with pluggable module interface
- `IdempotencyModule` with full atomic locking support
- `MemoryStore` and `RedisStore` built-in implementations
- `IdempotencyStore` interface for custom backends
- `ReliabilityValidationError` — thrown at startup on misconfiguration, never during requests
- Full ESM and CommonJS support

## 0.3.0 — 2026-03-24

### Added

- Extracted from `reliability-kit` into standalone `@reliability-tools/core` package
- `ReliabilityEngine` — framework-agnostic core
- `ReliabilityModule` interface — foundation for future modules (circuit breaker, rate limiting)
- `RequestContext` interface — adapter contract

## 0.2.0 — 2026-03-22

### Added

- Fingerprint validation on `IdempotencyModule`
- Three strategies: `method`, `method+path`, `full`
- `fingerprint` field on `IdempotencyRecord`
