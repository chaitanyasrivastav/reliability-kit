import { ReliabilityEngine } from '../core/engine'
import { IdempotencyModule } from '../modules/idempotency/idempotency'
import { ReliabilityOptions } from '../types/options'

export function createReliability(options: ReliabilityOptions) {
  const modules = []

  if (options.idempotency?.enabled) {
    modules.push(new IdempotencyModule(options.idempotency))
  }

  const engine = new ReliabilityEngine(modules)

  return {
    engine,
  }
}
