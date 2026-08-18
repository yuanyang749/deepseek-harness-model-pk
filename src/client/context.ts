import type { ComponentType } from 'react'

export type TransportRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

export interface ModelPkClientContext {
  readonly connection: {
    readonly rpc: {
      call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<TransportRpcResult>
    }
  }
  readonly slots: {
    inject(name: string, setup: () => (() => void) | void): () => void
    register(
      options: { readonly name: string; readonly id?: string; readonly order?: number },
      component: ComponentType<Record<string, unknown>>,
    ): () => void
  }
  effect(effect: () => (() => void) | Promise<() => void>, label?: string): () => Promise<void>
}
