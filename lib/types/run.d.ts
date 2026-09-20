/**
 * One-shot Qoder lifecycle: spawn the real qodercli under the shared subprocess
 * owner, submit the task over stdin, accept only a strict terminal result, and
 * dispose to whole-range quiescence.
 *
 * @module dsh-subagent-qoder/run
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { type SubagentResult, type SubagentRun, type SubagentStartRequest, type SubagentStopReason } from '@deepseek-ai/dsh-subagent';
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess';
import { qoderSpawnSpec, type QoderWireSpec } from './wire.ts';
/** Default POSIX grace between subprocess termination tiers. */
export declare const DEFAULT_DISPOSE_GRACE_MS = 3000;
export type { QoderPermissionMode, QoderWireSpec } from './wire.ts';
export { QODER_PERMISSION_MODES, QODER_FULL_ACCESS_MODES, DEFAULT_QODER_PERMISSION_MODE } from './wire.ts';
/** Host-side inputs: the wire spec plus the process service and diagnostics. */
export interface QoderRunSpec extends QoderWireSpec {
    /** Shared subprocess service spawn operation. */
    readonly spawn: (spec: ReturnType<typeof qoderSpawnSpec>) => SubprocessHandle;
    /** Host diagnostic sink for a product failure kept outside model-visible text. */
    readonly onError?: (error: Error, stopReason: SubagentStopReason) => void;
}
/**
 * Hide a startup failure behind fixed safe facts.
 * @param cause - original host-side failure retained only on the Error cause chain.
 * @returns a rejection safe to expose through the subagent start boundary.
 */
export declare function qoderStartupFailure(cause: unknown): Error;
/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact text sequence as one prompt string.
 */
export declare function textTask(prompt: readonly ContentBlock[]): string;
/**
 * Consume protocol lines until a strict terminal result, ignoring the child's
 * reasoning, tool traffic, and hook chatter, which never reach the parent.
 * @param lines - async stream of stdout lines.
 * @returns the completed shared result.
 */
export declare function consumeQoderStream(lines: AsyncIterable<string>): Promise<SubagentResult>;
/**
 * Terminate the managed range and wait for the owner to prove quiescence.
 * @param child - shared handle owning the qodercli managed range.
 */
export declare function disposeQoderChild(child: SubprocessHandle): Promise<void>;
/**
 * Start one qodercli one-shot run and publish its run handle.
 * @param request - resolved shared subagent request.
 * @param spec - wire inputs plus the process service and diagnostic policy.
 * @returns the published run after the child exists.
 */
export declare function startQoderRun(request: SubagentStartRequest, spec: QoderRunSpec): Promise<SubagentRun>;
