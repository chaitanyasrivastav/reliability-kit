import { createReliability, ReliabilityOptions } from '@reliability/core'
import { fastifyAdapter } from './adapter'

export function reliability(options: ReliabilityOptions) {
  const { engine } = createReliability(options)
  return fastifyAdapter(engine)
}
