import { createReliability, ReliabilityOptions } from '@reliability/core'
import { expressAdapter } from './adapter'

export function reliability(options: ReliabilityOptions) {
  const { engine } = createReliability(options)
  return expressAdapter(engine)
}
