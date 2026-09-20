/**
 * Minimal wire client for one `qodercli --print --output-format stream-json`
 * run: build the argv, drive the child's stdin, and accept only a strict
 * terminal `result` message out of the JSONL stream.
 *
 * Deliberately dependency-free: the Profile installs no Qoder package, so pnpm's
 * third-party build-script gate never applies and `dsh plugin add` is enough.
 *
 * @module dsh-subagent-qoder/wire
 */

import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Non-interactive permission modes the CLI actually accepts. */
export const QODER_PERMISSION_MODES = [
  'yolo',
  'bypassPermissions',
  'dontAsk',
  'acceptEdits',
  'auto',
] as const

/** Profile-selectable non-interactive Qoder permission mode. */
export type QoderPermissionMode = typeof QODER_PERMISSION_MODES[number]

/** Full-authority modes; `yolo` is `--yolo`, the other a `--permission-mode` value. */
export const QODER_FULL_ACCESS_MODES = ['yolo', 'bypassPermissions'] as const satisfies readonly QoderPermissionMode[]

/** Safe default for unattended Qoder runs. */
export const DEFAULT_QODER_PERMISSION_MODE: QoderPermissionMode = 'yolo'

/**
 * Map a Profile permission mode onto CLI flags.
 * @param mode - the configured mode.
 * @returns argv fragment selecting that mode.
 */
export function permissionFlags(mode: QoderPermissionMode): string[] {
  // `yolo` is its own flag; the SDK suppresses `--dangerously-skip-permissions`
  // for it, and the CLI's `--permission-mode` enum has no `plan` member.
  if (mode === 'yolo') return ['--yolo']
  return ['--permission-mode', {
    bypassPermissions: 'bypass_permissions',
    dontAsk: 'dont_ask',
    acceptEdits: 'accept_edits',
    auto: 'auto',
  }[mode]]
}

/** Inputs for one CLI invocation. */
export interface QoderWireSpec {
  /** Discovered or configured qodercli executable. */
  readonly cliPath: string
  /** Parent Session workspace, already validated by the seam. */
  readonly cwd: string
  /** Permission mode fixed for this provider instance. */
  readonly permissionMode: QoderPermissionMode
  /** Optional model override; omitted to use native Qoder settings. */
  readonly model?: string
  /** Explicit child environment layered over the scrubbed parent environment. */
  readonly env: Record<string, string>
  /** Managed-range termination grace. */
  readonly disposeGraceMs: number
}

/**
 * Build the fully explicit subprocess request for one one-shot run.
 * The task text travels over stdin rather than argv, so a long or quoted
 * delegation prompt cannot exceed a command-line limit or need shell escaping.
 * @param spec - executable, workspace, permission, model, and environment.
 * @returns a shared subprocess spawn request.
 */
export function qoderSpawnSpec(spec: QoderWireSpec): SubprocessSpawnSpec {
  const argv = [
    spec.cliPath,
    '--print',
    '--output-format', 'stream-json',
    // One-shot and unresumable, matching the provider's persistence contract.
    '--no-session-persistence',
    ...permissionFlags(spec.permissionMode),
    ...spec.model === undefined ? [] : ['--model', spec.model],
  ]
  return {
    argv,
    cwd: spec.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    graceMs: spec.disposeGraceMs,
    env: spec.env,
  }
}

/** One parsed protocol line. */
interface WireLine {
  readonly type?: string
  readonly subtype?: string
}

/**
 * Strictly derive the only result that can complete a run.
 * @param message - a parsed `type: result` line.
 * @returns exact final text for a successful, non-error result.
 * @throws QoderFailure-compatible Error describing the failure facts.
 */
export function parseResultLine(line: WireLine & {
  readonly is_error?: boolean
  readonly result?: string
  readonly errors?: string[]
}): { readonly text: string; readonly detail?: string } {
  if (line.subtype !== 'success') {
    const errors = Array.isArray(line.errors) ? line.errors.filter(Boolean) : []
    return {
      text: '',
      detail: [
        `subtype: ${line.subtype ?? 'unknown'}`,
        ...errors.length > 0 ? [`errors: ${errors.join('; ')}`] : [],
      ].join('; '),
    }
  }
  if (line.is_error || line.result === undefined || line.result.trim().length === 0) {
    return { text: '', detail: 'result marked error or blank final text' }
  }
  return { text: line.result }
}

/**
 * Accumulate a stdout chunk stream into newline-delimited protocol lines.
 * A trailing partial line is retained until its newline arrives.
 * @returns feed and flush operations.
 */
export function createLineBuffer(): {
  feed: (chunk: string) => string[]
  flush: () => string[]
} {
  let pending = ''
  const feed = (chunk: string): string[] => {
    pending += chunk
    const parts = pending.split(/\r?\n/)
    pending = parts.pop() ?? ''
    return parts.filter(line => line.trim().length > 0)
  }
  const flush = (): string[] => {
    const rest = pending
    pending = ''
    return rest.trim().length > 0 ? [rest] : []
  }
  return { feed, flush }
}

export type { WireLine }
