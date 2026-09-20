/**
 * Profile-named Qoder one-shot subagent provider. Every accepted run spawns the
 * real qodercli in the delegating Session's workspace under the shared
 * subprocess owner.
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
const CLI_PATH_ENV_VAR = 'QODER_CLI_PATH'
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const

/** Deployment-owned model, permission, proxy, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `qoder`). */
  providerName?: string
  /** Qoder model fixed for this instance; omitted to inherit Qoder settings. */
  model?: string
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Optional absolute path override; omitted to discover the CLI. */
  pathToQoderCLIExecutable?: string
  /**
   * Proxy URL exported to the child as `HTTP_PROXY`, `HTTPS_PROXY`, and
   * `ALL_PROXY`. Omitted to fall back to those variables when already present
   * in the inherited environment, then to the operating-system setting.
   */
  proxy?: string
  /** Use an inherited `HTTP(S)_PROXY` or the OS system proxy when `proxy` is omitted. Defaults to true. */
  useSystemProxy?: boolean
  /**
   * Native non-interactive mode fixed for this Provider instance. Defaults to
   * `yolo` (full authority: nothing is surfaced or awaited, since this provider
   * has no human approval channel). `acceptEdits` accepts edits and denies the
   * rest, `auto` uses the native classifier, `dontAsk` denies anything not
   * already authorized, and `bypassPermissions` is the same effective authority
   * as `yolo` under a different spelling.
   */
  permissionMode?: QoderPermissionMode
  /** Grace in milliseconds between Qoder managed-range termination tiers. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  model: z.string().min(1),
  env: z.dict(z.string()).default({}),
  pathToQoderCLIExecutable: z.string().min(1),
  proxy: z.string().min(1),
  useSystemProxy: z.boolean().default(true),
  permissionMode: z.union([...QODER_PERMISSION_MODES])
    .default(DEFAULT_QODER_PERMISSION_MODE),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Omit<
  Required<Config>,
  'model' | 'pathToQoderCLIExecutable' | 'proxy'
> & Pick<Config, 'model' | 'pathToQoderCLIExecutable' | 'proxy'>

/** `host:port` with no scheme, the shape the Windows registry stores. */
const PROXY_HOST_PORT = /^[A-Za-z0-9._-]+:\d{1,5}$/

function normalizeProxy(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (value === undefined || value.length === 0) return undefined
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return value
  // A per-protocol list such as `http=h:1;https=h:1` is not representable as one
  // URL, so leave it to an explicit `proxy` rather than guessing.
  return PROXY_HOST_PORT.test(value) ? `http://${value}` : undefined
}

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
 * @returns an absolute executable path, or `undefined` when none is found.
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

/**
 * Read the Windows per-user system proxy, so a delegated child follows the same
 * route the parent harness does. Other platforms are served by `proxy` or an
 * inherited environment variable rather than untested platform calls.
 */
function windowsSystemProxy(): string | undefined {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  const readValue = (name: string): string | undefined => {
    const result = spawnSync('reg', ['query', key, '/v', name], { encoding: 'utf8' })
    if (result.status !== 0) return undefined
    const pattern = new RegExp(`^\\s*${name}\\s+REG_[A-Z_]+\\s+(.+)$`, 'mi')
    return result.stdout.match(pattern)?.[1]?.trim()
  }
  if (readValue('ProxyEnable') !== '0x1') return undefined
  return normalizeProxy(readValue('ProxyServer'))
}

/**
 * Resolve the child's outbound proxy: explicit config, then the inherited
 * environment, then the operating-system setting.
 * @param config - provider deployment settings.
 * @returns a proxy URL, or `undefined` to inherit as-is.
 */
export function resolveProxy(config: Pick<Config, 'proxy' | 'useSystemProxy'>): string | undefined {
  const explicit = normalizeProxy(config.proxy)
  if (explicit !== undefined) return explicit
  if (config.useSystemProxy === false) return undefined
  const fromEnv = normalizeProxy(
    process.env.HTTPS_PROXY ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY ?? process.env.http_proxy,
  )
  if (fromEnv !== undefined) return fromEnv
  return process.platform === 'win32' ? windowsSystemProxy() : undefined
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
    if (this.config.pathToQoderCLIExecutable === undefined) {
      throw new Error(
        'subagent-qoder: no qodercli executable found; set pathToQoderCLIExecutable on the provider row',
      )
    }
    let cwd: string
    try {
      cwd = resolveChildCwd('subagent-qoder', undefined, parentCwd)
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error('subagent-qoder: request was aborted before spawn')
      }
      const failure = qoderStartupFailure(error)
      this.ctx.logger.warn(
        `subagent-qoder "${this.name}": child start failed: %o`, failure,
      )
      throw failure
    }
    const spec: QoderRunSpec = {
      cliPath: this.config.pathToQoderCLIExecutable,
      cwd,
      ...this.config.model === undefined ? {} : { model: this.config.model },
      permissionMode: this.config.permissionMode,
      // The CLI has no token option: authentication and account state remain
      // whatever this executable's own login provides.
      env: {
        ...this.config.env,
        ...this.config.proxy === undefined
          ? {}
          : Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, this.config.proxy as string])),
      },
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-qoder "${this.name}": child run failed (${stopReason}): %o`, error,
        )
      },
    }
    return startQoderRun(request, spec)
  }
}

/**
 * Register one Profile-named Qoder provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model, permission mode, proxy, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const cliPath = config.pathToQoderCLIExecutable ?? discoverQoderCLI()
  const proxy = resolveProxy(config)
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    ...config.model === undefined ? {} : { model: config.model },
    env: config.env as Record<string, string>,
    pathToQoderCLIExecutable: cliPath,
    ...proxy === undefined ? {} : { proxy },
    useSystemProxy: config.useSystemProxy ?? true,
    permissionMode: config.permissionMode ?? DEFAULT_QODER_PERMISSION_MODE,
    disposeGraceMs: config.disposeGraceMs as number,
  }
  if (cliPath === undefined) {
    ctx.logger.warn(
      'subagent-qoder: no qodercli executable found via QODER_CLI_PATH, PATH, or the'
      + ' default ~/.qoder-cn/bin/qoderclicn and ~/.qoder/bin/qodercli locations. Set'
      + ' pathToQoderCLIExecutable on the provider row.',
    )
  }
  ctx.logger.debug('subagent-qoder: child proxy = %s', proxy ?? 'inherited')
  assertPositiveFinite('subagent-qoder', 'disposeGraceMs', resolved.disposeGraceMs)
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-qoder: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(new QoderProvider(
    resolved.providerName, ctx, resolved,
  ))
}
