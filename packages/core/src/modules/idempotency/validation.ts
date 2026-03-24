import { ReliabilityOptions } from '../../types/options'

/**
 * A structured validation error that carries both a human-readable
 * message and a machine-readable code. The code allows callers to
 * programmatically distinguish between different failure reasons
 * without parsing the message string.
 */
export interface ValidationError {
  /**
   * Machine-readable error code — stable across library versions.
   * Safe to use in conditionals or error handling logic.
   */
  code: ValidationErrorCode

  /**
   * Human-readable description of what is wrong and how to fix it.
   * Includes the invalid value where relevant so the user doesn't
   * have to look it up.
   */
  message: string
}

/**
 * All possible validation error codes.
 *
 * Codes are namespaced by module (IDEMPOTENCY_*) so they remain
 * unambiguous as more modules are added in future versions.
 */
export type ValidationErrorCode =
  | 'IDEMPOTENCY_STORE_REQUIRED'
  | 'IDEMPOTENCY_PROCESSING_TTL_EXCEEDS_TTL'
  | 'IDEMPOTENCY_TTL_MUST_BE_POSITIVE'
  | 'IDEMPOTENCY_PROCESSING_TTL_MUST_BE_POSITIVE'

/**
 * Thrown when ReliabilityOptions fail validation.
 *
 * Carries all validation errors found in a single pass — not just the
 * first one — so the user can fix all problems at once rather than
 * discovering them one by one on each startup attempt.
 *
 * @example
 * ```typescript
 * try {
 *   app.use(reliability(options))
 * } catch (err) {
 *   if (err instanceof ReliabilityValidationError) {
 *     err.errors.forEach(e => console.error(`[${e.code}] ${e.message}`))
 *   }
 * }
 * ```
 */
export class ReliabilityValidationError extends Error {
  /**
   * All validation errors found in the options object.
   * Always contains at least one error — the constructor enforces this.
   */
  readonly errors: ValidationError[]

  constructor(errors: ValidationError[]) {
    const summary = errors.map((e) => `  • [${e.code}] ${e.message}`).join('\n')
    super(`reliability-kit configuration is invalid:\n${summary}`)
    this.name = 'ReliabilityValidationError'
    this.errors = errors

    // Maintains proper prototype chain in environments that compile
    // TypeScript to ES5, where extending built-in classes can lose
    // the correct prototype without this explicit assignment.
    Object.setPrototypeOf(this, ReliabilityValidationError.prototype)
  }
}

/**
 * Validates ReliabilityOptions and throws ReliabilityValidationError
 * if any configuration problems are found.
 *
 * Designed to be called at setup time — in reliability() before any
 * adapter or module is constructed — so misconfiguration is caught
 * immediately on startup rather than during a live request.
 *
 * Collects ALL errors in a single pass rather than throwing on the
 * first one, so users can fix everything at once.
 *
 * @param options — the options object passed to reliability().
 * @throws {ReliabilityValidationError} if any validation rule fails.
 *
 * @example
 * ```typescript
 * // Called internally by reliability() — users do not call this directly.
 * validateOptions({
 *   framework: Framework.EXPRESS,
 *   idempotency: {
 *     enabled: true,
 *     store: new RedisStore(client),
 *     ttl: 3600,
 *     processingTtl: 30,
 *   }
 * })
 * ```
 */
export function validateOptions(options: ReliabilityOptions): void {
  const errors: ValidationError[] = [...validateIdempotencyOptions(options)]

  if (errors.length > 0) {
    throw new ReliabilityValidationError(errors)
  }
}

/**
 * Validates the idempotency section of ReliabilityOptions.
 *
 * Only runs when idempotency is explicitly enabled — if the field is
 * absent or enabled is false, all idempotency rules are skipped.
 *
 * Returns an array of errors rather than throwing — the caller
 * (validateOptions) accumulates errors from all modules before throwing.
 */
function validateIdempotencyOptions(options: ReliabilityOptions): ValidationError[] {
  const errors: ValidationError[] = []
  const idempotency = options.idempotency

  // Idempotency is not enabled — nothing to validate.
  if (!idempotency?.enabled) return errors

  // ── Rule 1: store is required when enabled ─────────────────────────
  //
  // The store is the backbone of idempotency — without it the module
  // has nowhere to persist locks or completed responses. This is a
  // hard requirement, not a default-able one.
  if (!idempotency.store) {
    errors.push({
      code: 'IDEMPOTENCY_STORE_REQUIRED',
      message:
        'idempotency.store is required when idempotency is enabled. ' +
        'Pass a RedisStore instance for production or a MemoryStore for development.',
    })
  }

  // ── Rule 2: ttl must be a positive number ──────────────────────────
  //
  // A zero or negative ttl means completed responses expire immediately
  // or in the past — effectively disabling caching entirely. This is
  // almost certainly a misconfiguration rather than intentional.
  if (idempotency.ttl !== undefined && idempotency.ttl <= 0) {
    errors.push({
      code: 'IDEMPOTENCY_TTL_MUST_BE_POSITIVE',
      message:
        `idempotency.ttl must be a positive number of seconds. ` + `Received: ${idempotency.ttl}.`,
    })
  }

  // ── Rule 3: processingTtl must be a positive number ────────────────
  //
  // A zero or negative processingTtl means the processing lock expires
  // immediately — no request would ever hold the lock long enough to
  // execute the handler, causing every request to be treated as a duplicate.
  if (idempotency.processingTtl !== undefined && idempotency.processingTtl <= 0) {
    errors.push({
      code: 'IDEMPOTENCY_PROCESSING_TTL_MUST_BE_POSITIVE',
      message:
        `idempotency.processingTtl must be a positive number of seconds. ` +
        `Received: ${idempotency.processingTtl}.`,
    })
  }

  // ── Rule 4: processingTtl must be less than ttl ───────────────────
  //
  // If processingTtl >= ttl, the processing lock can outlive the cached
  // completed response. A retry arriving after ttl expires would find
  // no completed record but potentially still see a stuck processing lock
  // — leading to a confusing 409 in-progress for a request the user
  // believes has long since completed.
  //
  // Only validated when both values are explicitly set — if either uses
  // its default, the defaults (processingTtl: 30, ttl: 3600) are already
  // correct and this check is not needed.
  if (
    idempotency.ttl !== undefined &&
    idempotency.processingTtl !== undefined &&
    idempotency.processingTtl >= idempotency.ttl
  ) {
    errors.push({
      code: 'IDEMPOTENCY_PROCESSING_TTL_EXCEEDS_TTL',
      message:
        `idempotency.processingTtl must be less than idempotency.ttl. ` +
        `processingTtl (${idempotency.processingTtl}s) must be shorter than ` +
        `ttl (${idempotency.ttl}s) to avoid a processing lock outliving the cached response.`,
    })
  }

  return errors
}
