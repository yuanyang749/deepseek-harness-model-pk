import type { ComponentType } from 'react'
import { ModelPkApi } from './api.js'
import { ModelPkOverlay, SidebarAction } from './App.js'
import type { ModelPkClientContext } from './context.js'
import { ModelPkUiController } from './controller.js'

export const name = 'model-pk-client'
export const inject = ['slots', 'connection']

export function apply(ctx: ModelPkClientContext): void {
  const controller = new ModelPkUiController(new ModelPkApi(ctx))
  const Action = ((props: Record<string, unknown>) => <SidebarAction controller={controller} wide={props.wide === true} />) as ComponentType<Record<string, unknown>>
  const Overlay = (() => <ModelPkOverlay controller={controller} />) as ComponentType<Record<string, unknown>>
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'model-pk',
    order: 50,
  }, Action))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'model-pk',
    order: 50,
  }, Overlay))
}

export { ModelPkUiController }
