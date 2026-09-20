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
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
/** Non-interactive permission modes the CLI actually accepts. */
export declare const QODER_PERMISSION_MODES: readonly ["yolo", "bypassPermissions", "dontAsk", "acceptEdits", "auto"];
/** Profile-selectable non-interactive Qoder permission mode. */
export type QoderPermissionMode = typeof QODER_PERMISSION_MODES[number];
/** Full-authority modes; `yolo` is `--yolo`, the other a `--permission-mode` value. */
export declare const QODER_FULL_ACCESS_MODES: readonly ["yolo", "bypassPermissions"];
/** Safe default for unattended Qoder runs. */
export declare const DEFAULT_QODER_PERMISSION_MODE: QoderPermissionMode;
/**
 * Map a Profile permission mode onto CLI flags.
 * @param mode - the configured mode.
 * @returns argv fragment selecting that mode.
 */
export declare function permissionFlags(mode: QoderPermissionMode): string[];
/** Inputs for one CLI invocation. */
export interface QoderWireSpec {
    /** Discovered or configured qodercli executable. */
    readonly cliPath: string;
    /** Parent Session workspace, already validated by the seam. */
    readonly cwd: string;
    /** Permission mode fixed for this provider instance. */
    readonly permissionMode: QoderPermissionMode;
    /** Optional model override; omitted to use native Qoder settings. */
    readonly model?: string;
    /** Explicit child environment layered over the scrubbed parent environment. */
    readonly env: Record<string, string>;
    /** Managed-range termination grace. */
    readonly disposeGraceMs: number;
}
/**
 * Build the fully explicit subprocess request for one one-shot run.
 * The task text travels over stdin rather than argv, so a long or quoted
 * delegation prompt cannot exceed a command-line limit or need shell escaping.
 * @param spec - executable, workspace, permission, model, and environment.
 * @returns a shared subprocess spawn request.
 */
export declare function qoderSpawnSpec(spec: QoderWireSpec): SubprocessSpawnSpec;
/** One parsed protocol line. */
interface WireLine {
    readonly type?: string;
    readonly subtype?: string;
}
/**
 * Strictly derive the only result that can complete a run.
 * @param message - a parsed `type: result` line.
 * @returns exact final text for a successful, non-error result.
 * @throws QoderFailure-compatible Error describing the failure facts.
 */
export declare function parseResultLine(line: WireLine & {
    readonly is_error?: boolean;
    readonly result?: string;
    readonly errors?: string[];
}): {
    readonly text: string;
    readonly detail?: string;
};
/**
 * Accumulate a stdout chunk stream into newline-delimited protocol lines.
 * A trailing partial line is retained until its newline arrives.
 * @returns feed and flush operations.
 */
export declare function createLineBuffer(): {
    feed: (chunk: string) => string[];
    flush: () => string[];
};
export type { WireLine };
