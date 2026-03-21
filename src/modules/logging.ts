import { ReliabilityModule } from '../core/module'
import { RequestContext } from '../core/context'

export class LoggingModule implements ReliabilityModule {
  async execute(ctx: RequestContext, next: () => Promise<void>) {
    console.log('Request:', ctx.method, ctx.path)

    await next()

    console.log('Request finished')
  }
}
