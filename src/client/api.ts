import { BUSINESS_RPC_CHANNEL, NATIVE_RPC_CHANNEL } from '../contracts/constants.js'
import type { ModelPkError, WireResult } from '../contracts/types.js'
import type { ModelPkClientContext } from './context.js'

export class ClientApiError extends Error {
  constructor(readonly detail: ModelPkError) {
    super(detail.userMessage)
    this.name = 'ClientApiError'
  }
}

export class ModelPkApi {
  constructor(private readonly context: ModelPkClientContext) {}

  business<T>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    return this.call<T>(BUSINESS_RPC_CHANNEL, endpoint, payload, signal)
  }

  native<T>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    return this.call<T>(NATIVE_RPC_CHANNEL, endpoint, payload, signal)
  }

  private async call<T>(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const outer = await this.context.connection.rpc.call(channel, endpoint, payload, signal)
    if (!outer.ok) throw new Error(`${outer.error.code}: ${outer.error.message}`)
    const inner = outer.value as WireResult<T>
    if (typeof inner !== 'object' || inner === null || !('ok' in inner)) throw new Error('Model PK RPC returned an invalid response')
    if (!inner.ok) throw new ClientApiError(inner.error)
    return inner.value
  }
}
