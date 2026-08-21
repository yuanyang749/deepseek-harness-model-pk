import type {
  CapabilityReport,
  Draft,
  ModelConfigSnapshot,
  PreflightSnapshot,
  ResolvedHarness,
  TaskPackage,
} from '../src/contracts/types.js'
import { defaultExecutionConditions } from '../src/domain/factory.js'
import { hashCanonical, sha256Text } from '../src/core/jcs.js'

export function fixtureModel(ordinal: number): ModelConfigSnapshot {
  const base = {
    schemaVersion: 'model-pk/model-config/v1' as const,
    modelConfigId: hashCanonical({ providerRoute: `provider-${ordinal}`, modelId: `model-${ordinal}` }),
    providerRoute: `provider-${ordinal}`,
    providerProfileId: hashCanonical({ provider: ordinal }),
    providerDisplayName: `Provider ${ordinal}`,
    modelId: `model-${ordinal}`,
    modelName: `Model ${ordinal}`,
    adapterPackage: '@deepseek-ai/dsh-llm-deepseek',
    adapterVersion: '0.1.0-rc.7',
    protocol: 'deepseek-chat',
    revision: 'unresolved',
    inputModalities: ['text'] as const,
    contextWindow: 128_000,
    defaultMaxTokens: 8192,
    outputTokenCapacity: 8192,
    maxOutputTokens: 8192,
    reasoning: false,
    nonSensitiveSettings: {},
    retryPolicy: { mode: 'none' },
    serializerDependencies: { 'eventsource-parser': '3.1.1' },
  }
  return { ...base, fingerprint: hashCanonical(base) }
}

export function fixtureHarness(): ResolvedHarness {
  const base = {
    schemaVersion: 'model-pk/harness/v1' as const,
    preset: 'model-pk-v1' as const,
    systemPrompt: 'fixed',
    tools: [],
    toolNames: ['bash', 'edit', 'glob', 'grep', 'read', 'write'],
    permissions: { network: 'denied' },
    agentLoop: { maxSteps: 64 },
    sandbox: { engine: 'seatbelt' },
    contextPolicy: { logicalWorkspace: '/workspace' },
    versions: { plugin: '0.1.0' },
  }
  return { ...base, fingerprint: hashCanonical(base) }
}

export function fixtureTaskPackage(): TaskPackage {
  const prompt = 'Implement the fixture.'
  return {
    schemaVersion: 'model-pk/task-package/v1',
    taskName: 'Fixture experiment',
    taskType: 'test',
    prompt,
    promptHash: sha256Text(prompt),
    attachments: [],
    baseline: null,
    selectedModelConfigIds: [fixtureModel(1).modelConfigId, fixtureModel(2).modelConfigId],
  }
}

export function fixturePreflight(): PreflightSnapshot {
  const taskPackage = fixtureTaskPackage()
  const harness = fixtureHarness()
  const conditions = defaultExecutionConditions(2)
  const models = [fixtureModel(1), fixtureModel(2)]
  const core = {
    draftId: '00000000-0000-4000-8000-000000000001',
    taskPackageHash: hashCanonical(taskPackage),
    models: models.map(model => model.fingerprint),
    harness: harness.fingerprint,
  }
  return {
    preflightId: '00000000-0000-4000-8000-000000000002',
    draftId: core.draftId,
    draftRevision: 1,
    snapshotHash: hashCanonical(core),
    status: 'READY',
    checks: [],
    resultRootPath: '/tmp/model-pk-results',
    taskPackage,
    taskPackageHash: core.taskPackageHash,
    models,
    resolvedHarness: harness,
    resolvedHarnessFingerprint: harness.fingerprint,
    executionConditions: conditions,
    executionConditionsHash: hashCanonical(conditions),
    capacityEstimateBytes: 512 * 1024,
    confirmedSnapshotHash: null,
    createdAt: '2026-08-18T00:00:00.000Z',
  }
}

export function fixtureDraft(): Draft {
  return {
    draftId: '00000000-0000-4000-8000-000000000001',
    revision: 0,
    taskName: '',
    taskType: '',
    prompt: '',
    promptHash: sha256Text(''),
    selectedModelConfigIds: [],
    attachments: [],
    baseline: null,
    resultRootPath: null,
    concurrency: 1,
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
  }
}

export function fixtureCapability(): CapabilityReport {
  return {
    pluginVersion: '0.1.0',
    expectedDshVersion: '0.1.0-rc.7',
    expectedDshCommit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
    hostPlatform: 'darwin',
    hostArch: 'arm64',
    dataRoot: '/fixture/model-pk/v1',
    nativeHelper: { status: 'READY', path: '/fixture/helper', version: '0.1.0', hash: hashCanonical('helper'), reason: null },
    executionEnabled: true,
    blockers: [],
  }
}
