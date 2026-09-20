/**
 * Profile-named Qoder one-shot subagent provider. Every accepted run invokes
 * the Qoder Agent SDK in the delegating Session's workspace and places the
 * SDK-spawned real qodercli under the shared subprocess owner.
 *
 * @module dsh-subagent-qoder
 */

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
   * `dontAsk`; `acceptEdits` accepts edits, `auto` uses the native classifier,
   * `plan` returns a plan without approving execution, and
   * `bypassPermissions` explicitly skips permission checks.
   */
  permissionMode?: QoderPermissionMode
  /** Grace in milliseconds between Qoder managed-range termination tiers. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  model: z.string().min(1),
  authMode: z.union([...QODER_AUTH_MODES]).default('env'),
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
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    ...config.model === undefined ? {} : { model: config.model },
    authMode: config.authMode ?? 'env',
    authEnvVar: config.authEnvVar ?? DEFAULT_ACCESS_TOKEN_ENV_VAR,
    env: config.env as Record<string, string>,
    ...config.pathToQoderCLIExecutable === undefined
      ? {}
      : { pathToQoderCLIExecutable: config.pathToQoderCLIExecutable },
    permissionMode: config.permissionMode ?? DEFAULT_QODER_PERMISSION_MODE,
    disposeGraceMs: config.disposeGraceMs as number,
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
