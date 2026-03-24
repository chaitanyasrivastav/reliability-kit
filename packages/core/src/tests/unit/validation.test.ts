import {
  validateOptions,
  ReliabilityValidationError,
  ValidationError,
} from '../../modules/idempotency/validation'
import { ReliabilityOptions } from '../../types/options'
import { IdempotencyStore } from '../../modules/idempotency/stores/store'
import { describe, it, expect } from '@jest/globals'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal valid store — satisfies the IdempotencyStore interface
 * without any real implementation. Used to pass store validation
 * so tests can focus on the specific rule they're testing.
 */
const mockStore: IdempotencyStore = {
  acquire: async () => true,
  get: async () => null,
  set: async () => {},
  release: async () => {},
  delete: async () => {},
}

/**
 * Minimal valid options — passes all validation rules.
 * Tests override only the field relevant to their assertion.
 */
function validOptions(overrides: Partial<ReliabilityOptions> = {}): ReliabilityOptions {
  return {
    idempotency: {
      enabled: true,
      store: mockStore,
    },
    ...overrides,
  }
}

/**
 * Extracts error codes from a ReliabilityValidationError for concise assertions.
 */
function errorCodes(err: ReliabilityValidationError): string[] {
  return err.errors.map((e) => e.code)
}

/**
 * Asserts that validateOptions throws a ReliabilityValidationError and
 * returns it — avoids repeating the try/catch pattern in every test.
 */
function expectValidationError(options: ReliabilityOptions): ReliabilityValidationError {
  try {
    validateOptions(options)
    throw new Error('Expected validateOptions to throw but it did not')
  } catch (err) {
    if (err instanceof ReliabilityValidationError) return err
    throw err
  }
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('validateOptions — valid configurations', () => {
  it('does not throw for minimal valid options', () => {
    expect(() => validateOptions(validOptions())).not.toThrow()
  })

  it('does not throw when idempotency is not provided', () => {
    expect(() => validateOptions({})).not.toThrow()
  })

  it('does not throw when idempotency.enabled is false', () => {
    expect(() =>
      validateOptions({
        idempotency: { enabled: false, store: mockStore },
      }),
    ).not.toThrow()
  })

  it('does not throw when idempotency.enabled is false and store is absent', () => {
    // store is not required when not enabled
    expect(() =>
      validateOptions({
        idempotency: { enabled: false } as any,
      }),
    ).not.toThrow()
  })

  it('does not throw with all valid optional fields explicitly set', () => {
    expect(() =>
      validateOptions(
        validOptions({
          idempotency: {
            enabled: true,
            store: mockStore,
            ttl: 3600,
            processingTtl: 30,
            duplicateStrategy: 'cache',
          },
        }),
      ),
    ).not.toThrow()
  })

  it('does not throw when only ttl is set without processingTtl', () => {
    expect(() =>
      validateOptions(validOptions({ idempotency: { enabled: true, store: mockStore, ttl: 100 } })),
    ).not.toThrow()
  })

  it('does not throw when only processingTtl is set without ttl', () => {
    expect(() =>
      validateOptions(
        validOptions({ idempotency: { enabled: true, store: mockStore, processingTtl: 10 } }),
      ),
    ).not.toThrow()
  })

  it('does not throw when processingTtl is exactly 1 less than ttl', () => {
    expect(() =>
      validateOptions(
        validOptions({
          idempotency: { enabled: true, store: mockStore, ttl: 100, processingTtl: 99 },
        }),
      ),
    ).not.toThrow()
  })
})

// ─── ReliabilityValidationError shape ────────────────────────────────────────

describe('ReliabilityValidationError', () => {
  it('is an instance of Error', () => {
    const err = expectValidationError(validOptions({ idempotency: { enabled: true } as any }))
    expect(err).toBeInstanceOf(Error)
  })

  it('has name ReliabilityValidationError', () => {
    const err = expectValidationError(validOptions({ idempotency: { enabled: true } as any }))
    expect(err.name).toBe('ReliabilityValidationError')
  })

  it('message includes all error codes and messages', () => {
    const err = expectValidationError(
      validOptions({
        idempotency: {
          enabled: true,
          store: mockStore,
          ttl: 3600,
          processingTtl: 3600, // equal — triggers PROCESSING_TTL_EXCEEDS_TTL
        },
      }),
    )
    expect(err.message).toContain('IDEMPOTENCY_PROCESSING_TTL_EXCEEDS_TTL')
    expect(err.message).toContain('reliability-kit configuration is invalid')
  })

  it('errors array contains at least one error when thrown', () => {
    const err = expectValidationError(validOptions({ idempotency: { enabled: true } as any }))
    expect(err.errors.length).toBeGreaterThan(0)
  })

  it('each error has a code and a message', () => {
    const err = expectValidationError(validOptions({ idempotency: { enabled: true } as any }))
    err.errors.forEach((e: ValidationError) => {
      expect(e.code).toBeDefined()
      expect(typeof e.code).toBe('string')
      expect(e.message).toBeDefined()
      expect(typeof e.message).toBe('string')
      expect(e.message.length).toBeGreaterThan(0)
    })
  })
})

// ─── Rule 1: store required when enabled ─────────────────────────────────────

describe('IDEMPOTENCY_STORE_REQUIRED', () => {
  it('throws when store is absent and enabled is true', () => {
    const err = expectValidationError(validOptions({ idempotency: { enabled: true } as any }))
    expect(errorCodes(err)).toContain('IDEMPOTENCY_STORE_REQUIRED')
  })

  it('error message mentions store and how to fix it', () => {
    const err = expectValidationError(validOptions({ idempotency: { enabled: true } as any }))
    const storeError = err.errors.find((e) => e.code === 'IDEMPOTENCY_STORE_REQUIRED')
    expect(storeError?.message).toContain('idempotency.store')
    expect(storeError?.message).toContain('RedisStore')
  })

  it('does not throw when store is provided', () => {
    expect(() =>
      validateOptions(validOptions({ idempotency: { enabled: true, store: mockStore } })),
    ).not.toThrow()
  })

  it('does not throw when enabled is false even if store is absent', () => {
    expect(() =>
      validateOptions({
        idempotency: { enabled: false } as any,
      }),
    ).not.toThrow()
  })
})

// ─── Rule 2: ttl must be positive ────────────────────────────────────────────

describe('IDEMPOTENCY_TTL_MUST_BE_POSITIVE', () => {
  it('throws when ttl is 0', () => {
    const err = expectValidationError(
      validOptions({ idempotency: { enabled: true, store: mockStore, ttl: 0 } }),
    )
    expect(errorCodes(err)).toContain('IDEMPOTENCY_TTL_MUST_BE_POSITIVE')
  })

  it('throws when ttl is negative', () => {
    const err = expectValidationError(
      validOptions({ idempotency: { enabled: true, store: mockStore, ttl: -1 } }),
    )
    expect(errorCodes(err)).toContain('IDEMPOTENCY_TTL_MUST_BE_POSITIVE')
  })

  it('error message includes the invalid value', () => {
    const err = expectValidationError(
      validOptions({ idempotency: { enabled: true, store: mockStore, ttl: -100 } }),
    )
    const ttlError = err.errors.find((e) => e.code === 'IDEMPOTENCY_TTL_MUST_BE_POSITIVE')
    expect(ttlError?.message).toContain('-100')
  })

  it('does not throw when ttl is 1', () => {
    expect(() =>
      validateOptions(validOptions({ idempotency: { enabled: true, store: mockStore, ttl: 1 } })),
    ).not.toThrow()
  })

  it('does not throw when ttl is a large positive number', () => {
    expect(() =>
      validateOptions(
        validOptions({ idempotency: { enabled: true, store: mockStore, ttl: 86400 } }),
      ),
    ).not.toThrow()
  })

  it('does not throw when ttl is absent', () => {
    expect(() =>
      validateOptions(validOptions({ idempotency: { enabled: true, store: mockStore } })),
    ).not.toThrow()
  })
})

// ─── Rule 3: processingTtl must be positive ───────────────────────────────────

describe('IDEMPOTENCY_PROCESSING_TTL_MUST_BE_POSITIVE', () => {
  it('throws when processingTtl is 0', () => {
    const err = expectValidationError(
      validOptions({ idempotency: { enabled: true, store: mockStore, processingTtl: 0 } }),
    )
    expect(errorCodes(err)).toContain('IDEMPOTENCY_PROCESSING_TTL_MUST_BE_POSITIVE')
  })

  it('throws when processingTtl is negative', () => {
    const err = expectValidationError(
      validOptions({ idempotency: { enabled: true, store: mockStore, processingTtl: -5 } }),
    )
    expect(errorCodes(err)).toContain('IDEMPOTENCY_PROCESSING_TTL_MUST_BE_POSITIVE')
  })

  it('error message includes the invalid value', () => {
    const err = expectValidationError(
      validOptions({ idempotency: { enabled: true, store: mockStore, processingTtl: -5 } }),
    )
    const processingError = err.errors.find(
      (e) => e.code === 'IDEMPOTENCY_PROCESSING_TTL_MUST_BE_POSITIVE',
    )
    expect(processingError?.message).toContain('-5')
  })

  it('does not throw when processingTtl is 1', () => {
    expect(() =>
      validateOptions(
        validOptions({ idempotency: { enabled: true, store: mockStore, processingTtl: 1 } }),
      ),
    ).not.toThrow()
  })

  it('does not throw when processingTtl is absent', () => {
    expect(() =>
      validateOptions(validOptions({ idempotency: { enabled: true, store: mockStore } })),
    ).not.toThrow()
  })
})

// ─── Rule 4: processingTtl must be less than ttl ─────────────────────────────

describe('IDEMPOTENCY_PROCESSING_TTL_EXCEEDS_TTL', () => {
  it('throws when processingTtl equals ttl', () => {
    const err = expectValidationError(
      validOptions({
        idempotency: { enabled: true, store: mockStore, ttl: 100, processingTtl: 100 },
      }),
    )
    expect(errorCodes(err)).toContain('IDEMPOTENCY_PROCESSING_TTL_EXCEEDS_TTL')
  })

  it('throws when processingTtl exceeds ttl', () => {
    const err = expectValidationError(
      validOptions({
        idempotency: { enabled: true, store: mockStore, ttl: 30, processingTtl: 60 },
      }),
    )
    expect(errorCodes(err)).toContain('IDEMPOTENCY_PROCESSING_TTL_EXCEEDS_TTL')
  })

  it('error message includes both values', () => {
    const err = expectValidationError(
      validOptions({
        idempotency: { enabled: true, store: mockStore, ttl: 30, processingTtl: 60 },
      }),
    )
    const ttlError = err.errors.find((e) => e.code === 'IDEMPOTENCY_PROCESSING_TTL_EXCEEDS_TTL')
    expect(ttlError?.message).toContain('60s')
    expect(ttlError?.message).toContain('30s')
  })

  it('does not throw when processingTtl is less than ttl', () => {
    expect(() =>
      validateOptions(
        validOptions({
          idempotency: { enabled: true, store: mockStore, ttl: 3600, processingTtl: 30 },
        }),
      ),
    ).not.toThrow()
  })

  it('does not throw when only ttl is set without processingTtl', () => {
    expect(() =>
      validateOptions(validOptions({ idempotency: { enabled: true, store: mockStore, ttl: 30 } })),
    ).not.toThrow()
  })

  it('does not throw when only processingTtl is set without ttl', () => {
    expect(() =>
      validateOptions(
        validOptions({ idempotency: { enabled: true, store: mockStore, processingTtl: 9999 } }),
      ),
    ).not.toThrow()
  })
})

// ─── Multiple errors collected in one pass ────────────────────────────────────

describe('multiple errors — all collected at once', () => {
  it('returns all errors when store is missing and ttl is invalid', () => {
    const err = expectValidationError(
      validOptions({
        idempotency: {
          enabled: true,
          ttl: -1,
        } as any,
      }),
    )
    expect(errorCodes(err)).toContain('IDEMPOTENCY_STORE_REQUIRED')
    expect(errorCodes(err)).toContain('IDEMPOTENCY_TTL_MUST_BE_POSITIVE')
    expect(err.errors).toHaveLength(2)
  })

  it('returns all errors when both ttl fields are invalid', () => {
    const err = expectValidationError(
      validOptions({
        idempotency: {
          enabled: true,
          store: mockStore,
          ttl: -1,
          processingTtl: -1,
        },
      }),
    )
    expect(errorCodes(err)).toContain('IDEMPOTENCY_TTL_MUST_BE_POSITIVE')
    expect(errorCodes(err)).toContain('IDEMPOTENCY_PROCESSING_TTL_MUST_BE_POSITIVE')
    expect(errorCodes(err)).toContain('IDEMPOTENCY_PROCESSING_TTL_EXCEEDS_TTL')
    expect(err.errors).toHaveLength(3)
  })

  it('returns all three errors when store missing and both ttls are negative', () => {
    const err = expectValidationError(
      validOptions({
        idempotency: {
          enabled: true,
          ttl: -1,
          processingTtl: -1,
        } as any,
      }),
    )
    expect(err.errors).toHaveLength(4)
    expect(errorCodes(err)).toContain('IDEMPOTENCY_STORE_REQUIRED')
    expect(errorCodes(err)).toContain('IDEMPOTENCY_TTL_MUST_BE_POSITIVE')
    expect(errorCodes(err)).toContain('IDEMPOTENCY_PROCESSING_TTL_MUST_BE_POSITIVE')
    expect(errorCodes(err)).toContain('IDEMPOTENCY_PROCESSING_TTL_EXCEEDS_TTL')
  })
})
