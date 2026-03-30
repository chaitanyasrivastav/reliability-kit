# @reliability-tools/core

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
