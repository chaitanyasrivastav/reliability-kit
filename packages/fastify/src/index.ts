import { createReliability, ReliabilityOptions } from '@reliability-tools/core'
import { fastifyAdapter } from './adapter'

export function reliability(options: ReliabilityOptions) {
  const { engine } = createReliability(options)
  return fastifyAdapter(engine)
}
