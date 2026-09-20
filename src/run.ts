/**
 * One-shot Qoder lifecycle: invoke the Qoder Agent SDK, place its real
 * qodercli process under the shared subprocess owner, map only strict SDK
 * success to completion, and dispose to whole-range quiescence.
 *
 * @module dsh-subagent-qoder/run
 */

import { randomUUID } from 'node:crypto'
import {
  ProcessTransport,
  query as officialQuery,
  type AuthOptions,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SpawnOptions,
} from '@qoder-ai/qoder-agent-sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  ManagedQoderProcess,
  qoderSpawnSpec,
} from './process.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Qoder permission modes that cannot wait for a human response. */
export const QODER_PERMISSION_MODES = [
  'dontAsk',
  'acceptEdits',
  'auto',
  'plan',
  'bypassPermissions',
] as const satisfies readonly NonNullable<Options['permissionMode']>[]

/** Profile-selectable non-interactive Qoder permission mode. */
export type QoderPermissionMode = typeof QODER_PERMISSION_MODES[number]

/** Safe default for unattended Qoder runs. */
export const DEFAULT_QODER_PERMISSION_MODE: QoderPermissionMode = 'dontAsk'

type QoderFailureStage =
  | 'query-start'
  | 'query-run'
  | 'process'
  | 'teardown'

type QoderFailureCategory =
  | 'limit'
  | 'product-error'
  | 'invalid-result'
  | 'process'
  | 'unknown'

interface QoderFailureFacts {
  readonly stage: QoderFailureStage
  readonly category: QoderFailureCategory
  readonly outcome?: SubprocessOutcome | undefined
}

function failureDiagnostic(facts: QoderFailureFacts): string {
  const fields = [
    'product: Qoder',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  const exitCode = facts.outcome?.exitCode
  if (exitCode !== null && exitCode !== undefined) {
    fields.push(`exit code: ${exitCode}`)
  }
  const signal = facts.outcome?.signal
  if (signal !== null && signal !== undefined) {
    fields.push(`signal: ${signal}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

class QoderFailure extends Error {
  constructor(
    readonly facts: QoderFailureFacts,
    cause?: unknown,
  ) {
    super(
      `subagent-qoder: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'QoderFailure'
  }
}

function sdkFailureCategory(subtype: string): QoderFailureCategory {
  switch (subtype) {
    case 'error_max_turns':
    case 'error_max_budget_usd':
      return 'limit'
    case 'error_during_execution':
      return 'product-error'
    default:
      return 'unknown'
  }
}

/**
 * Hide an unpublished product startup failure behind fixed safe facts.
 * @param cause - original host-side failure retained only on the Error cause chain.
 * @returns a rejection safe to expose through the subagent start boundary.
 */
export function qoderStartupFailure(cause: unknown): Error {
  return new QoderFailure({ stage: 'query-start', category: 'unknown' }, cause)
}

function unattendedDiagnostic(
  mode: QoderPermissionMode,
  request: 'tool permission' | 'MCP elicitation',
  decision: 'denied' | 'declined',
  reason: string,
): string {
  return `Qoder unattended decision (mode: ${mode}; request: ${request}; decision: ${decision}): ${reason}`
}

/** Fully resolved inputs for one Qoder Agent SDK query. */
export interface QoderRunSpec {
  /** Parent Session workspace supplied to the SDK and real CLI. */
  readonly cwd: string
  /** Authentication for the direct qodercli child session. */
  readonly auth: AuthOptions
  /** Profile-selected model; omitted to preserve Qoder settings. */
  readonly model?: string
  /** Profile-selected native non-interactive permission mode. */
  readonly permissionMode: QoderPermissionMode
  /** Optional explicit path to the qodercli executable. */
  readonly pathToQoderCLIExecutable?: string
  /** Explicit deployment/test environment layered after shared scrubbing. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared managed-range owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Host diagnostic sink for a product failure kept outside model-visible text. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Read live request cancellation across awaited startup cleanup. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Validate and preserve the one-shot task before crossing the SDK boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact text sequence as one SDK prompt.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-qoder: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-qoder: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-qoder: the one-shot task must not be empty')
  }
  return texts.join('')
}

/**
 * Strictly derive the only SDK result that can complete a shared run.
 * @param message - the SDK discriminated result union.
 * @returns exact final text for a successful, non-error result.
 */
export function successfulResult(message: SDKResultMessage): string {
  if (message.subtype !== 'success') {
    const category = sdkFailureCategory(message.subtype)
    const detail = category === 'unknown'
      ? undefined
      : message.errors.join('; ')
    throw new QoderFailure(
      { stage: 'query-run', category },
      detail === undefined || detail.length === 0
        ? undefined
        : new Error(detail),
    )
  }
  if (message.is_error || message.result.trim().length === 0) {
    throw new QoderFailure({ stage: 'query-run', category: 'invalid-result' })
  }
  return message.result
}

/**
 * Consume the complete SDK stream and require one strict success plus normal
 * iterator completion.
 */
export async function consumeQoderQuery(
  query: AsyncIterable<SDKMessage>,
  onPermissionDenied?: () => void,
  onResult?: () => void,
): Promise<SubagentResult> {
  let answer: string | undefined
  for await (const message of query) {
    if (message.type === 'system' && message.subtype === 'permission_denied') {
      onPermissionDenied?.()
      continue
    }
    if (message.type !== 'result') continue
    onResult?.()
    answer = successfulResult(message)
  }
  if (answer === undefined) {
    throw new QoderFailure({ stage: 'query-run', category: 'invalid-result' })
  }
  return {
    output: [{ type: 'text', text: answer }],
    stopReason: 'completed',
  }
}

/**
 * Close the query, terminate the managed range, and wait for the subprocess
 * owner to prove it is quiescent.
 */
export async function disposeQoderChild(
  query: Pick<Query, 'close'> | undefined,
  child: SubprocessHandle,
): Promise<void> {
  const failures: Error[] = []
  let outcome: SubprocessOutcome | undefined
  void child.done.then(
    (value) => { outcome = value },
    () => {},
  )
  try {
    await query?.close()
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  child.terminate()
  try {
    await child.waitForExit()
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  const firstFailure = failures[0]
  if (firstFailure !== undefined) {
    const facts = { stage: 'teardown', category: 'unknown', outcome } as const
    const cause = failures.length === 1
      ? firstFailure
      : new AggregateError(failures, 'Qoder teardown failures')
    throw new QoderFailure(facts, cause)
  }
  await child.done.catch(() => {})
}

/**
 * Build the fixed SDK options for one one-shot provider run.
 * @param spec - Workspace, auth, environment, process service, and disposal policy.
 * @param controller - per-run cancellation owner.
 * @param capture - receives the shared child and SDK-facing process synchronously.
 * @param captureDiagnostic - receives safe facts from unattended interaction callbacks.
 * @returns options that inherit native settings while disabling persistence and user questions.
 */
export function qoderQueryOptions(
  spec: QoderRunSpec,
  controller: AbortController,
  capture: (
    child: SubprocessHandle,
    process: ManagedQoderProcess,
  ) => void,
  captureDiagnostic: (diagnostic: string) => void,
): Options {
  return {
    auth: spec.auth,
    // Force the child-process transport so the SDK calls `spawnQoderCLIProcess`
    // and dsh's subprocess seam owns the qodercli managed range. The SDK's baked
    // default is the `worker` transport, which runs the runtime in a worker
    // thread and never fires the spawn hook — leaving dsh unable to terminate it.
    transport: ProcessTransport.default,
    abortController: controller,
    cwd: spec.cwd,
    ...spec.model === undefined ? {} : { model: spec.model },
    ...spec.pathToQoderCLIExecutable === undefined
      ? {}
      : { pathToQoderCLIExecutable: spec.pathToQoderCLIExecutable },
    env: { ...scrubbedParentEnv(), ...spec.env },
    persistSession: false,
    disallowedTools: spec.permissionMode === 'plan'
      ? ['AskUserQuestion', 'ExitPlanMode']
      : ['AskUserQuestion'],
    permissionMode: spec.permissionMode,
    ...spec.permissionMode === 'bypassPermissions'
      ? { allowDangerouslySkipPermissions: true }
      : {
        canUseTool: () => {
          captureDiagnostic(unattendedDiagnostic(
            spec.permissionMode,
            'tool permission',
            'denied',
            'the provider does not request human approval',
          ))
          return Promise.resolve({
            behavior: 'deny' as const,
            message: 'This unattended Qoder subagent cannot request human approval.',
          })
        },
      },
    onElicitation: () => {
      captureDiagnostic(unattendedDiagnostic(
        spec.permissionMode,
        'MCP elicitation',
        'declined',
        'the provider does not collect interactive MCP input',
      ))
      return Promise.resolve({ action: 'decline' } as const)
    },
    spawnQoderCLIProcess: (options: SpawnOptions) => {
      const child = spec.spawn(qoderSpawnSpec(options, spec.disposeGraceMs))
      const process = new ManagedQoderProcess(child)
      capture(child, process)
      return process
    },
  }
}

/**
 * Start one Qoder Agent SDK query and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, auth, environment, process service, and diagnostic policy.
 * @returns the published run after both Query and the real CLI handle exist.
 */
export async function startQoderRun(
  request: SubagentStartRequest,
  spec: QoderRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-qoder: request was aborted before SDK startup')
  }

  const controller = new AbortController()
  const requestCancel = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('subagent-qoder: run cancelled locally'))
    }
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })
  const reportFailure = (error: Error): void => {
    try {
      spec.onError?.(error, 'error')
    } catch {
      // Host diagnostic logging cannot replace the product failure.
    }
  }

  let child: SubprocessHandle | undefined
  let childFailure: Error | undefined
  let childProcessFailure: Promise<never> | undefined
  let query: Query | undefined
  let managedProcess: ManagedQoderProcess | undefined
  let diagnostic: string | undefined
  const capturePermissionDiagnostic = (value: string): void => {
    diagnostic = value
  }
  const prependFailureDiagnostic = (facts: QoderFailureFacts): void => {
    const failure = failureDiagnostic(facts)
    diagnostic = diagnostic === undefined
      ? failure
      : `${failure}\n${diagnostic}`
  }
  const captureChild = (
    captured: SubprocessHandle,
    process: ManagedQoderProcess,
  ): void => {
    child = captured
    managedProcess = process
    childProcessFailure = captured.done.then(
      () => new Promise<never>(() => {}),
      (error: unknown) => {
        childFailure = thrown(error)
        throw childFailure
      },
    )
    void childProcessFailure.catch(() => {})
  }
  try {
    query = officialQuery({
      prompt,
      options: qoderQueryOptions(
        spec,
        controller,
        captureChild,
        capturePermissionDiagnostic,
      ),
    })
    // The Qoder SDK starts its transport lazily: nothing spawns, and so nothing
    // calls `spawnQoderCLIProcess`, until the session is driven. Force the
    // initialize handshake so the managed child handle exists before publication.
    await query.initializationResult()
    if (child === undefined || childProcessFailure === undefined) {
      throw new Error(
        'subagent-qoder: SDK did not publish a controllable qodercli process',
      )
    }
    if (isAborted(controller.signal)) {
      throw new Error('subagent-qoder: request was aborted before SDK startup')
    }
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = controller.signal.aborted
    await Promise.resolve()
    const startupOutcome = managedProcess?.outcome
    const startupFacts = {
      stage: 'query-start',
      category: 'unknown',
      outcome: startupOutcome,
    } as const
    const startupFailure = (cause: unknown = childFailure ?? error): QoderFailure => new QoderFailure(
      startupFacts,
      thrown(cause),
    )
    requestCancel()
    if (child !== undefined) {
      try {
        await disposeQoderChild(query, child)
      } catch (disposeError: unknown) {
        const failure = startupFailure()
        const cleanupFailure = thrown(disposeError)
        const aggregate = new AggregateError(
          [failure, cleanupFailure],
          `${failure.message}; ${cleanupFailure.message}`,
        )
        reportFailure(aggregate)
        throw aggregate
      }
      if (cancelledBeforeCleanup || isAborted(request.signal)) {
        throw new Error('subagent-qoder: request was aborted before SDK startup')
      }
      const failure = startupFailure()
      reportFailure(failure)
      throw failure
    } else if (query !== undefined) {
      try {
        await query.close()
      } catch (disposeError: unknown) {
        const failure = startupFailure()
        const cleanupFailure = new QoderFailure({
          stage: 'teardown',
          category: 'unknown',
        }, thrown(disposeError))
        const aggregate = new AggregateError(
          [failure, cleanupFailure],
          `${failure.message}; ${cleanupFailure.message}`,
        )
        reportFailure(aggregate)
        throw aggregate
      }
    }
    if (cancelledBeforeCleanup || isAborted(request.signal)) {
      throw new Error('subagent-qoder: request was aborted before SDK startup')
    }
    const failure = startupFailure()
    reportFailure(failure)
    throw failure
  }

  const publishedQuery = query
  const publishedChild = child
  const publishedProcessFailure = childProcessFailure
  let receivedResult = false
  const result = settleRunResult({
    attempt: async () => {
      try {
        return await Promise.race([
          consumeQoderQuery(publishedQuery, () => {
            capturePermissionDiagnostic(unattendedDiagnostic(
              spec.permissionMode,
              'tool permission',
              'denied',
              'Qoder denied the request before an interactive prompt',
            ))
          }, () => {
            receivedResult = true
          }),
          publishedProcessFailure,
        ])
      } catch (error: unknown) {
        const processOutcome = managedProcess?.outcome
        let facts: QoderFailureFacts
        if (error instanceof QoderFailure) {
          facts = { ...error.facts, outcome: processOutcome }
        } else if (processOutcome !== undefined && !receivedResult) {
          facts = { stage: 'process', category: 'process', outcome: processOutcome }
        } else {
          facts = { stage: 'query-run', category: 'unknown', outcome: processOutcome }
        }
        prependFailureDiagnostic(facts)
        throw error instanceof QoderFailure
          ? error
          : new QoderFailure(facts, thrown(error))
      }
    },
    collectOutput: () => [],
    collectDiagnostic: () => diagnostic,
    cancelled: () => controller.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      try {
        await disposeQoderChild(publishedQuery, publishedChild)
      } catch (error: unknown) {
        const failure = thrown(error)
        reportFailure(failure)
        throw failure
      }
    },
  })
}
