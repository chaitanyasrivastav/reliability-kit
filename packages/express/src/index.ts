import { createReliability, ReliabilityOptions } from '@reliability-tools/core'
import { expressAdapter } from './adapter'

export { MemoryStore, RedisStore, ReliabilityValidationError } from '@reliability-tools/core'

export function reliability(options: ReliabilityOptions) {
  const { engine } = createReliability(options)
  return expressAdapter(engine)
}
