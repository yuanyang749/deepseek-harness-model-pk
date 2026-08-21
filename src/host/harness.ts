import { DSH_COMMIT, DSH_VERSION, HARNESS_PRESET, LIMITS, PLUGIN_VERSION } from '../contracts/constants.js'
import type { ResolvedHarness } from '../contracts/types.js'
import { hashCanonical } from '../core/jcs.js'
import type { SandboxRunner } from '../native/sandbox.js'

export const MODEL_PK_SYSTEM_PROMPT = `You are running one frozen Model PK coding attempt.

Work only inside the logical /workspace directory. Treat it as the complete task workspace. Do not inspect host paths, shared state, credentials, the network, other attempts, or prior sessions. The task prompt and ordered attachments are the only user inputs.

Use only bash, read, write, edit, glob, and grep. Use workspace-relative paths and '/' separators for file-tool paths on every host. The bash tool runs the host shell (bash on macOS, PowerShell on Windows). Tool calls execute serially. Produce the best direct answer to the task, and make workspace changes when the task requires them. Do not ask for another agent, external CLI, web access, memory, skills, goals, plans, or hidden context.

Your final response is the raw result for this attempt. Do not score, rank, compare against other models, or mention Model PK.`

export const TOOL_CONTRACTS = Object.freeze([
  {
    name: 'bash',
    description: 'Run one non-interactive host-shell command inside /workspace (bash on macOS, PowerShell on Windows). Network and paths outside this attempt are denied.',
    parameters: objectSchema({ command: { type: 'string', minLength: 1 } }, ['command']),
    output: objectSchema({ exitCode: { type: 'integer', description: '-1 when the process ended by signal' }, stdout: { type: 'string' }, stderr: { type: 'string' }, timedOut: { type: 'boolean' }, truncated: { type: 'boolean' } }, ['exitCode', 'stdout', 'stderr', 'timedOut', 'truncated']),
  },
  {
    name: 'read',
    description: 'Read a UTF-8 file at a relative path inside /workspace.',
    parameters: objectSchema({ path: { type: 'string', minLength: 1 } }, ['path']),
    output: objectSchema({ content: { type: 'string' }, byteLength: { type: 'integer' }, hash: { type: 'string' } }, ['content', 'byteLength', 'hash']),
  },
  {
    name: 'write',
    description: 'Atomically write a UTF-8 file at a relative path inside /workspace.',
    parameters: objectSchema({ path: { type: 'string', minLength: 1 }, content: { type: 'string' }, executable: { type: 'boolean' } }, ['path', 'content']),
    output: objectSchema({ byteLength: { type: 'integer' }, hash: { type: 'string' } }, ['byteLength', 'hash']),
  },
  {
    name: 'edit',
    description: 'Replace one exact text occurrence, or all occurrences when all=true, in a UTF-8 file inside /workspace.',
    parameters: objectSchema({ path: { type: 'string', minLength: 1 }, old: { type: 'string', minLength: 1 }, replacement: { type: 'string' }, all: { type: 'boolean' } }, ['path', 'old', 'replacement']),
    output: objectSchema({ replacements: { type: 'integer' }, byteLength: { type: 'integer' }, hash: { type: 'string' } }, ['replacements', 'byteLength', 'hash']),
  },
  {
    name: 'glob',
    description: 'List workspace-relative paths matching one glob pattern. Results are deterministic and sorted.',
    parameters: objectSchema({ pattern: { type: 'string', minLength: 1 } }, ['pattern']),
    output: objectSchema({ paths: { type: 'array', items: { type: 'string' } } }, ['paths']),
  },
  {
    name: 'grep',
    description: 'Search UTF-8 workspace files for a literal string or regular expression.',
    parameters: objectSchema({ pattern: { type: 'string', minLength: 1 }, glob: { type: 'string' }, regex: { type: 'boolean' } }, ['pattern']),
    output: objectSchema({ matches: { type: 'array', items: { type: 'object' } }, truncated: { type: 'boolean' } }, ['matches', 'truncated']),
  },
] as const)

export function resolveHarness(sandbox: SandboxRunner): ResolvedHarness {
  const orderedTools = [...TOOL_CONTRACTS].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  const base = {
    schemaVersion: 'model-pk/harness/v1' as const,
    preset: HARNESS_PRESET as typeof HARNESS_PRESET,
    systemPrompt: MODEL_PK_SYSTEM_PROMPT,
    tools: orderedTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: tool.output,
    })),
    toolNames: orderedTools.map(tool => tool.name),
    permissions: {
      filesystem: 'attempt-root-only',
      network: 'denied',
      environment: 'allowlist',
      sharedTemp: 'denied',
      subprocess: sandbox.subprocessPolicy(),
      dshSessionSandboxMode: 'read-only',
      dshSessionApprovalPolicy: 'never',
      dshSessionPermissionPreset: 'custom',
    },
    agentLoop: {
      implementation: '@deepseek-ai/dsh-agent-loop',
      maxParallelToolCalls: LIMITS.maxParallelToolCalls,
      toolExecutionMode: 'exclusive',
      maxSteps: LIMITS.maxSteps,
      maxOutputTokens: LIMITS.outputTokens,
      hiddenProviderRetry: false,
    },
    sandbox: sandbox.normalizedPolicy(),
    contextPolicy: {
      historyTranscript: false,
      memory: false,
      automaticCompaction: false,
      logicalWorkspace: '/workspace',
      normalizeAttemptLocalValues: true,
      actualPathVisibleToModel: false,
      sessionIdVisibleToModel: false,
    },
    versions: {
      plugin: PLUGIN_VERSION,
      dsh: DSH_VERSION,
      dshCommit: DSH_COMMIT,
      agentLoop: DSH_VERSION,
      sandboxContract: sandbox.contractVersion(),
      toolContract: 'model-pk-tools-v1',
    },
  }
  return Object.freeze({ ...base, fingerprint: hashCanonical(base) })
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.freeze({ type: 'object', properties, required, additionalProperties: false })
}
