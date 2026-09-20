/**
 * Profile-named Qoder one-shot subagent provider. Every accepted run invokes
 * the Qoder Agent SDK in the delegating Session's workspace and places the
 * SDK-spawned real qodercli under the shared subprocess owner.
 *
 * @module dsh-subagent-qoder
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  accessTokenFromEnv,
  qodercliAuth,
  type AuthOptions,
} from '@qoder-ai/qoder-agent-sdk'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  QODER_PERMISSION_MODES,
  DEFAULT_QODER_PERMISSION_MODE,
  qoderStartupFailure,
  startQoderRun,
  type QoderPermissionMode,
  type QoderRunSpec,
} from './run.ts'

export const name = 'subagent-qoder'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'qoder'
const DEFAULT_ACCESS_TOKEN_ENV_VAR = 'QODER_PERSONAL_ACCESS_TOKEN'

/** How the provider authenticates the direct qodercli child session. */
export const QODER_AUTH_MODES = ['env', 'qodercli'] as const
/** Selectable Qoder authentication mode. */
export type QoderAuthMode = typeof QODER_AUTH_MODES[number]

/** Deployment-owned model, auth, permission, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `qoder`). */
  providerName?: string
  /** Qoder model fixed for this instance; omitted to inherit Qoder settings. */
  model?: string
  /**
   * Authentication source for the child session: `env` reads a personal access
   * token from `authEnvVar`; `qodercli` reuses local `qodercli login` state.
   */
  authMode?: QoderAuthMode
  /** Environment variable holding the token when `authMode` is `env`. */
  authEnvVar?: string
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment. A child token must be supplied
   * here (or resolved via `authMode: env`), never relied upon from the parent.
   */
  env?: Record<string, string>
  /** Optional absolute path to the qodercli executable; omitted to resolve from PATH. */
  pathToQoderCLIExecutable?: string
  /**
   * Native non-interactive mode fixed for this Provider instance. Defaults to
   * `yolo` (full authority: no permission is ever surfaced or awaited, since
   * this provider has no human approval channel). `acceptEdits` accepts edits
   * and denies the rest, `auto` uses the native classifier, `plan` returns a
   * plan without approving execution, and `bypassPermissions` is the same
   * effective mode as `yolo` under a different spelling.
   */
  permissionMode?: QoderPermissionMode
  /** Grace in milliseconds between Qoder managed-range termination tiers. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  model: z.string().min(1),
  authMode: z.union([...QODER_AUTH_MODES]).default('qodercli'),
  authEnvVar: z.string().min(1).default(DEFAULT_ACCESS_TOKEN_ENV_VAR),
  env: z.dict(z.string()).default({}),
  pathToQoderCLIExecutable: z.string().min(1),
  permissionMode: z.union([...QODER_PERMISSION_MODES])
    .default(DEFAULT_QODER_PERMISSION_MODE),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Omit<Required<Config>, 'model' | 'pathToQoderCLIExecutable'>
  & Pick<Config, 'model' | 'pathToQoderCLIExecutable'>

function buildAuth(config: ResolvedConfig): AuthOptions {
  return config.authMode === 'qodercli'
    ? qodercliAuth()
    : accessTokenFromEnv(config.authEnvVar)
}

/** Environment override for the CLI location, so a deployment needs no config row. */
const CLI_PATH_ENV_VAR = 'QODER_CLI_PATH'

function executableOnPath(names: readonly string[]): string | undefined {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  for (const name of names) {
    const result = spawnSync(probe, [name], { encoding: 'utf8' })
    if (result.status !== 0) continue
    const found = result.stdout.split(/\r?\n/)[0]?.trim()
    if (found !== undefined && existsSync(found)) return found
  }
  return undefined
}

/**
 * Locate a usable CLI so the common install needs no `pathToQoderCLIExecutable`.
 * Required because this provider must use the process transport, and the SDK's
 * default package runtime is the global-brand worker, which cannot authenticate
 * against a CN-only login.
 */
export function discoverQoderCLI(): string | undefined {
  const fromEnv = process.env[CLI_PATH_ENV_VAR]?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) return fromEnv
  const onPath = executableOnPath(['qoderclicn', 'qodercli'])
  if (onPath !== undefined) return onPath
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const home = homedir()
  for (const dir of [
    join(home, '.qoder-cn', 'bin', 'qoderclicn'),
    join(home, '.qoder', 'bin', 'qodercli'),
  ]) {
    for (const base of ['qoderclicn', 'qodercli']) {
      const candidate = join(dir, `${base}${suffix}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

class QoderProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-qoder: no working directory for the child — delegate from a parent session that has one',
      )
    }
    let cwd: string
    try {
      cwd = resolveChildCwd('subagent-qoder', undefined, parentCwd)
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error(
          'subagent-qoder: request was aborted before SDK startup',
        )
      }
      const failure = qoderStartupFailure(error)
      this.ctx.logger.warn(
        `subagent-qoder "${this.name}": child start failed: %o`,
        failure,
      )
      throw failure
    }
    const spec: QoderRunSpec = {
      cwd,
      auth: buildAuth(this.config),
      ...this.config.model === undefined ? {} : { model: this.config.model },
      ...this.config.pathToQoderCLIExecutable === undefined
        ? {}
        : { pathToQoderCLIExecutable: this.config.pathToQoderCLIExecutable },
      permissionMode: this.config.permissionMode,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-qoder "${this.name}": child run failed (${stopReason}): %o`,
          error,
        )
      },
    }
    return startQoderRun(request, spec)
  }
}

/**
 * Register one Profile-named Qoder provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model, auth, permission mode, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const cliPath = config.pathToQoderCLIExecutable ?? discoverQoderCLI()
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    ...config.model === undefined ? {} : { model: config.model },
    authMode: config.authMode ?? 'qodercli',
    authEnvVar: config.authEnvVar ?? DEFAULT_ACCESS_TOKEN_ENV_VAR,
    env: config.env as Record<string, string>,
    pathToQoderCLIExecutable: cliPath,
    permissionMode: config.permissionMode ?? DEFAULT_QODER_PERMISSION_MODE,
    disposeGraceMs: config.disposeGraceMs as number,
  }
  if (cliPath === undefined) {
    ctx.logger.warn(
      'subagent-qoder: no qodercli executable found via QODER_CLI_PATH, PATH, or the'
      + ' default ~/.qoder-cn/bin/qoderclicn and ~/.qoder/bin/qodercli locations. The'
      + ' process transport needs one, so delegations will fail; set'
      + ' pathToQoderCLIExecutable on the provider row.',
    )
  }
  assertPositiveFinite(
    'subagent-qoder',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-qoder: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(new QoderProvider(
    resolved.providerName,
    ctx,
    resolved,
  ))
}
