import { createReliability, ReliabilityOptions } from '@reliability-tools/core'
import { expressAdapter } from './adapter'

export function reliability(options: ReliabilityOptions) {
  const { engine } = createReliability(options)
  return expressAdapter(engine)
}
