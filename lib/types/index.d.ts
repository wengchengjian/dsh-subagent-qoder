/**
 * Profile-named Qoder one-shot subagent provider. Every accepted run spawns the
 * real qodercli in the delegating Session's workspace under the shared
 * subprocess owner.
 *
 * @module dsh-subagent-qoder
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type QoderPermissionMode } from './run.ts';
export declare const name = "subagent-qoder";
export declare const inject: string[];
/** Deployment-owned model, permission, proxy, environment, and process-release settings. */
export interface Config {
    /** Provider name on `ctx.subagents` (default `qoder`). */
    providerName?: string;
    /** Qoder model fixed for this instance; omitted to inherit Qoder settings. */
    model?: string;
    /**
     * Explicit environment entries layered over the subprocess seam's
     * credential-scrubbed parent environment.
     */
    env?: Record<string, string>;
    /** Optional absolute path override; omitted to discover the CLI. */
    pathToQoderCLIExecutable?: string;
    /**
     * Proxy URL exported to the child as `HTTP_PROXY`, `HTTPS_PROXY`, and
     * `ALL_PROXY`. Omitted to fall back to those variables when already present
     * in the inherited environment, then to the operating-system setting.
     */
    proxy?: string;
    /** Use an inherited `HTTP(S)_PROXY` or the OS system proxy when `proxy` is omitted. Defaults to true. */
    useSystemProxy?: boolean;
    /**
     * Native non-interactive mode fixed for this Provider instance. Defaults to
     * `yolo` (full authority: nothing is surfaced or awaited, since this provider
     * has no human approval channel). `acceptEdits` accepts edits and denies the
     * rest, `auto` uses the native classifier, `dontAsk` denies anything not
     * already authorized, and `bypassPermissions` is the same effective authority
     * as `yolo` under a different spelling.
     */
    permissionMode?: QoderPermissionMode;
    /** Grace in milliseconds between Qoder managed-range termination tiers. */
    disposeGraceMs?: number;
}
export declare const Config: z<Config>;
/**
 * Locate a usable CLI so the common install needs no `pathToQoderCLIExecutable`.
 * @returns an absolute executable path, or `undefined` when none is found.
 */
export declare function discoverQoderCLI(): string | undefined;
/**
 * Resolve the child's outbound proxy: explicit config, then the inherited
 * environment, then the operating-system setting.
 * @param config - provider deployment settings.
 * @returns a proxy URL, or `undefined` to inherit as-is.
 */
export declare function resolveProxy(config: Pick<Config, 'proxy' | 'useSystemProxy'>): string | undefined;
/**
 * Register one Profile-named Qoder provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model, permission mode, proxy, child environment, and disposal grace.
 */
export declare function apply(ctx: Context, config: Config): void;
