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
