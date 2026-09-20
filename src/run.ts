/**
 * One-shot Qoder lifecycle: spawn the real qodercli under the shared subprocess
 * owner, submit the task over stdin, accept only a strict terminal result, and
 * dispose to whole-range quiescence.
 *
 * @module dsh-subagent-qoder/run
 */

import { randomUUID } from 'node:crypto'
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
import type {
  SubprocessHandle,
  SubprocessOutcome,
} from '@deepseek-ai/dsh-subprocess'
import {
  createLineBuffer,
  parseResultLine,
  qoderSpawnSpec,
  type QoderPermissionMode,
  type QoderWireSpec,
} from './wire.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

export type { QoderPermissionMode, QoderWireSpec } from './wire.ts'
export { QODER_PERMISSION_MODES, QODER_FULL_ACCESS_MODES, DEFAULT_QODER_PERMISSION_MODE } from './wire.ts'

/** Host-side inputs: the wire spec plus the process service and diagnostics. */
export interface QoderRunSpec extends QoderWireSpec {
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: ReturnType<typeof qoderSpawnSpec>) => SubprocessHandle
  /** Host diagnostic sink for a product failure kept outside model-visible text. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

type QoderFailureStage = 'spawn' | 'run' | 'process' | 'teardown'
type QoderFailureCategory = 'limit' | 'product-error' | 'invalid-result' | 'process' | 'unknown'

interface QoderFailureFacts {
  readonly stage: QoderFailureStage
  readonly category: QoderFailureCategory
  readonly outcome?: SubprocessOutcome | undefined
}

function failureDiagnostic(facts: QoderFailureFacts): string {
  const fields = ['product: Qoder', `stage: ${facts.stage}`, `category: ${facts.category}`]
  const { exitCode, signal } = facts.outcome ?? {}
  if (exitCode !== null && exitCode !== undefined) fields.push(`exit code: ${exitCode}`)
  if (signal !== null && signal !== undefined) fields.push(`signal: ${signal}`)
  return `Product subagent failure (${fields.join('; ')})`
}

class QoderFailure extends Error {
  constructor(readonly facts: QoderFailureFacts, detail?: string, cause?: unknown) {
    const base = `subagent-qoder: ${failureDiagnostic(facts)}`
    super(detail === undefined || detail.length === 0 ? base : `${base}; ${detail}`,
      cause === undefined ? undefined : { cause })
    this.name = 'QoderFailure'
  }
}

function categoryForSubtype(subtype: string): QoderFailureCategory {
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
 * Hide a startup failure behind fixed safe facts.
 * @param cause - original host-side failure retained only on the Error cause chain.
 * @returns a rejection safe to expose through the subagent start boundary.
 */
export function qoderStartupFailure(cause: unknown): Error {
  return new QoderFailure({ stage: 'spawn', category: 'unknown' }, undefined, cause)
}

function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact text sequence as one prompt string.
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
 * Consume protocol lines until a strict terminal result, ignoring the child's
 * reasoning, tool traffic, and hook chatter, which never reach the parent.
 * @param lines - async stream of stdout lines.
 * @returns the completed shared result.
 */
export async function consumeQoderStream(
  lines: AsyncIterable<string>,
): Promise<SubagentResult> {
  for await (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // Non-protocol noise on stdout is not a failure.
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const message = parsed as Record<string, unknown>
    if (message.type !== 'result') continue
    const outcome = parseResultLine(message as Parameters<typeof parseResultLine>[0])
    if (outcome.detail !== undefined) {
      throw new QoderFailure(
        { stage: 'run', category: typeof message.subtype === 'string'
          ? categoryForSubtype(message.subtype) : 'invalid-result' },
        outcome.detail,
      )
    }
    return {
      output: [{ type: 'text', text: outcome.text }],
      stopReason: 'completed',
    }
  }
  throw new QoderFailure({ stage: 'run', category: 'invalid-result' }, 'stream ended with no result message')
}

/**
 * Turn one stdout byte stream into a line stream the consumer can iterate.
 * @param source - the child's stdout, or `undefined` when unavailable.
 * @returns an async line iterable.
 */
function toLineStream(source: NodeJS.ReadableStream | undefined): AsyncIterable<string> {
  const { feed, flush } = createLineBuffer()
  return {
    async *[Symbol.asyncIterator]() {
      if (source === undefined) return
      const iterable = source as AsyncIterable<Buffer | string>
      for await (const chunk of iterable) {
        for (const line of feed(chunk.toString('utf8'))) yield line
      }
      for (const line of flush()) yield line
    },
  }
}

/**
 * Terminate the managed range and wait for the owner to prove quiescence.
 * @param child - shared handle owning the qodercli managed range.
 */
export async function disposeQoderChild(child: SubprocessHandle): Promise<void> {
  const failures: Error[] = []
  let outcome: SubprocessOutcome | undefined
  void child.done.then((value) => { outcome = value }, () => {})
  try {
    child.stdin?.end()
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
    const cause = failures.length === 1
      ? firstFailure
      : new AggregateError(failures, 'Qoder teardown failures')
    throw new QoderFailure({ stage: 'teardown', category: 'unknown', outcome }, undefined, cause)
  }
  await child.done.catch(() => {})
}

/**
 * Start one qodercli one-shot run and publish its run handle.
 * @param request - resolved shared subagent request.
 * @param spec - wire inputs plus the process service and diagnostic policy.
 * @returns the published run after the child exists.
 */
export async function startQoderRun(
  request: SubagentStartRequest,
  spec: QoderRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-qoder: request was aborted before spawn')
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

  let child: SubprocessHandle
  try {
    child = spec.spawn(qoderSpawnSpec(spec))
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    requestCancel()
    const failure = new QoderFailure(
      { stage: 'spawn', category: 'unknown' }, undefined, thrown(error),
    )
    reportFailure(failure)
    throw failure
  }

  // Deliver the task, then close stdin so the child starts and terminates.
  try {
    child.stdin?.write(prompt)
    child.stdin?.end()
  } catch (error: unknown) {
    const failure = new QoderFailure(
      { stage: 'spawn', category: 'unknown' }, undefined, thrown(error),
    )
    void disposeQoderChild(child).catch(() => {})
    request.signal.removeEventListener('abort', onAbort)
    requestCancel()
    reportFailure(failure)
    throw failure
  }

  const publishedFailure = child.done.then(
    (outcome) => new Promise<never>((_resolve, reject) => {
      reject(new QoderFailure(
        { stage: 'process', category: 'process', outcome },
        'qodercli exited before publishing a result',
      ))
    }),
  )
  void publishedFailure.catch(() => {})

  let receivedResult = false
  const result = settleRunResult({
    attempt: async () => {
      try {
        const value = await Promise.race([
          (async () => {
            const settled = await consumeQoderStream(toLineStream(child.stdout))
            receivedResult = true
            return settled
          })(),
          publishedFailure,
        ])
        return value
      } catch (error: unknown) {
        if (receivedResult || error instanceof QoderFailure) throw error
        throw new QoderFailure({ stage: 'run', category: 'unknown' }, undefined, thrown(error))
      }
    },
    collectOutput: () => [],
    collectDiagnostic: () => undefined,
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
        await disposeQoderChild(child)
      } catch (error: unknown) {
        const failure = thrown(error)
        reportFailure(failure)
        throw failure
      }
    },
  })
}
