import type { DshHostContext } from './host/dsh.js'
import { ModelPkRuntime, type Config } from './host/runtime.js'

export const name = 'model-pk'
export const inject = ['connection', 'llm', 'agents', 'settings', 'attachments']

export function apply(ctx: DshHostContext, config: Config = {}): void {
  if (ctx.effect === undefined) throw new Error('Model PK requires the DSH Cordis effect lifecycle')
  ctx.effect(async () => {
    const runtime = await ModelPkRuntime.create(ctx, config)
    return () => runtime.dispose()
  }, 'model-pk: runtime')
}

export type { Config }
export * from './contracts/types.js'
export * from './contracts/rpc.js'
