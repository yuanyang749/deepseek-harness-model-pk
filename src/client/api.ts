import { BUSINESS_RPC_CHANNEL, NATIVE_RPC_CHANNEL } from '../contracts/constants.js'
import type { ModelPkError, WireResult } from '../contracts/types.js'
import type { ModelPkClientContext } from './context.js'
import type { SettingsDescribeValue, SettingsMutationRequest, SettingsNamespaceView } from './vision-settings.js'

export class ClientApiError extends Error {
  constructor(readonly detail: ModelPkError) {
    super(detail.userMessage)
    this.name = 'ClientApiError'
  }
}

export class DshApiError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message)
    this.name = 'DshApiError'
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

  async settingsDescribe(): Promise<SettingsDescribeValue> {
    return this.unwrapDsh(await this.context.connection.api.settings.describe({}))
  }

  async settingsMutate(payload: SettingsMutationRequest): Promise<SettingsNamespaceView> {
    return this.unwrapDsh(await this.context.connection.api.settings.mutate(payload))
  }

  private async call<T>(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const outer = await this.context.connection.rpc.call(channel, endpoint, payload, signal)
    if (!outer.ok) throw new Error(`${outer.error.code}: ${outer.error.message}`)
    const inner = outer.value as WireResult<T>
    if (typeof inner !== 'object' || inner === null || !('ok' in inner)) throw new Error('Model PK RPC returned an invalid response')
    if (!inner.ok) throw new ClientApiError(inner.error)
    return inner.value
  }

  private unwrapDsh<T>(response: { readonly result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details?: unknown } } }): T {
    if (!response.result.ok) throw new DshApiError(response.result.error.code, response.result.error.message, response.result.error.details)
    return response.result.value
  }
}
