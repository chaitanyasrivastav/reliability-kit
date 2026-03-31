import { ReliabilityEngine } from '../core/engine'
import { IdempotencyModule } from '../modules/idempotency/idempotency'
import { validateOptions } from '../modules/idempotency/validation'
import { ReliabilityOptions } from '../types/options'

export function createReliability(options: ReliabilityOptions) {
  validateOptions(options)

  const modules = []

  if (options.idempotency?.enabled) {
    modules.push(new IdempotencyModule(options.idempotency))
  }

  const engine = new ReliabilityEngine(modules)

  return {
    engine,
  }
}
