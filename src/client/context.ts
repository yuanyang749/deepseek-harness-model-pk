import type { ComponentType } from 'react'
import type { SettingsDescribeValue, SettingsMutationRequest, SettingsNamespaceView } from './vision-settings.js'

export type TransportRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

export type DshApiResponse<T> = {
  readonly result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details?: unknown } }
}

export interface ModelPkClientContext {
  readonly sessions: {
    refresh(): Promise<void>
    open(sessionId: string): void
  }
  readonly connection: {
    readonly api: {
      readonly settings: {
        describe(payload: Readonly<Record<string, never>>): Promise<DshApiResponse<SettingsDescribeValue>>
        mutate(payload: SettingsMutationRequest): Promise<DshApiResponse<SettingsNamespaceView>>
      }
    }
    readonly rpc: {
      call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<TransportRpcResult>
    }
  }
  readonly slots: {
    inject(name: string, setup: () => (() => void) | void): () => void
    register(
      options: {
        readonly name: string
        readonly id?: string
        readonly order?: number
        readonly label?: string | (() => string)
      },
      component: ComponentType<Record<string, unknown>>,
    ): () => void
  }
  effect(effect: () => (() => void) | Promise<() => void>, label?: string): () => Promise<void>
}
