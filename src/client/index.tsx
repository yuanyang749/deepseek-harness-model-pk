import { ModelPkApi } from './api.js'
import { ModelPkOverlay, ModelPkSettingsSection } from './App.js'
import type { ModelPkClientContext } from './context.js'
import { ModelPkUiController } from './controller.js'

export const name = 'model-pk-client'
export const inject = ['slots', 'connection']

export function apply(ctx: ModelPkClientContext): void {
  const controller = new ModelPkUiController(new ModelPkApi(ctx))
  const Section = (): JSX.Element => <ModelPkSettingsSection controller={controller} />
  const Overlay = (): JSX.Element => <ModelPkOverlay controller={controller} />
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'model-pk',
    order: 70,
    label: 'Model PK',
  }, Section))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'model-pk',
    order: 50,
  }, Overlay))
}

export { ModelPkUiController }
