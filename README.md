# dsh-subagent-qoder

One-shot Qoder subagent provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), built over the official [`@qoder-ai/qoder-agent-sdk`](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk). It is the Qoder sibling of `@deepseek-ai/dsh-subagent-claude-code`: a delegated task runs as a fresh, unattended `qodercli` session in the parent Session's workspace and returns only its final answer (or a safe failure diagnostic). Reasoning, tool traffic, stderr, and workspace diffs never enter the parent Session.

> This is an **out-of-tree Profile Bundle**, not a Qoder plugin. It plugs into dsh's subagent seam (`ctx.subagents`) and is exposed to the model through dsh's `@deepseek-ai/dsh-tool-subagent` tool row.

## When to use

Mount it when a delegation should run as a genuine Qoder CLI session with isolated context, and one-shot semantics (no continuation, resume, or pooling) are acceptable. Native Qoder settings and authentication remain authoritative; the Profile chooses the model, environment, permission mode, and auth source.

## Install

Add the Bundle to a Profile, then restart that Profile. Installation registers only the **dormant** provider and starts no `qodercli` process; the model cannot reach it until you compose a delegation tool row (below).

```sh
# from a local checkout (relative specs are anchored to the invoking directory)
dsh plugin --profile <name> add ../dsh-subagent-qoder
dsh --profile <name>
```

Installing controls Host availability, not model permission.

## Configure the provider

The provider row is registered by `cordis.patch.yml`. Add it directly to the Profile's `cordis.patch.yml`, or leave the defaults and only compose the tool row.

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `qoder` | Registry name on `ctx.subagents`; each mounted instance needs a unique value |
| `model` | native Qoder settings | Optional model fixed for every run from this instance |
| `authMode` | `env` | `env` reads a personal access token from `authEnvVar`; `qodercli` reuses local `qodercli login` state |
| `authEnvVar` | `QODER_PERSONAL_ACCESS_TOKEN` | Token variable when `authMode: env` |
| `env` | `{}` | Child environment layered over the credential-scrubbed parent environment |
| `pathToQoderCLIExecutable` | resolve from `PATH` | Optional absolute path to `qoderclicn` / `qodercli` |
| `permissionMode` | `dontAsk` | Non-interactive policy fixed for every run from this instance |
| `disposeGraceMs` | `3000` | Grace between managed-range termination tiers |

`permissionMode` values and their unattended behavior:

| Value | Behavior |
|---|---|
| `dontAsk` | Deny anything not already authorized instead of prompting |
| `acceptEdits` | Accept file edits; remaining permission prompts are denied by the unattended callback |
| `auto` | Let Qoder's native classifier allow or deny permission requests |
| `plan` | Run in planning mode, deny execution approval, return the plan as the final answer |
| `bypassPermissions` | Explicitly set `allowDangerouslySkipPermissions` and skip permission checks |

Credential-shaped ambient variables are removed before the `env` overlay, so a token intended for the child must be supplied via `authMode: env` or placed explicitly in `env`.

## Expose the delegation tool

The bundle's own `cordis.patch.yml` already registers the **dormant provider** row (`subagent-qoder`), so what you add to your Profile is the delegation **tool** row. Each delegation tool row names one provider and needs its own `toolName`, so the model sees a static tool rather than a dynamic provider selector. For `backgroundMode: one-shot` (a call returning a parent-owned Job id), the Profile also needs the shared Jobs registry and its controls — the base host and full presets usually already provide them.

Append the rows you are missing to your Profile's `cordis.patch.yml` (`$DSH_HOME/profiles/<name>/cordis.patch.yml`), then restart the Profile:

```yaml
# --- provider row: normally contributed by the installed bundle's own patch ---
- id: subagent-qoder
  name: 'dsh-subagent-qoder'
  config:
    providerName: qoder
    authMode: env
    permissionMode: dontAsk
    # pathToQoderCLIExecutable: 'C:/Users/you/.qoder-cn/bin/qoderclicn/qoderclicn.exe'

# --- jobs registry + controls (needed only for run_in_background: true) ------
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'

# --- the model-facing delegation tool ---------------------------------------
- id: tool-subagent-qoder
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: qoder
    toolName: subagent_qoder
    backgroundMode: one-shot
    maxDepth: provider-managed
```

**Agent preset:** the `@deepseek-ai/dsh-tool-subagent` row above exposes `subagent_qoder` to any agent composed from your Profile's rows. If a session is built from an Agent Preset instead, copy the preset and add a matching `@deepseek-ai/dsh-tool-subagent` tool entry (or flip its `disabled: true` to `false`); presets ship the row disabled so installing the Bundle alone never changes existing agents' tool surface.

A foreground call returns the final Qoder answer or an error with the stop reason and a safe diagnostic. A background call (`run_in_background: true`) returns a parent-owned Job id for `job_output` / `job_kill`.

## Authentication

`query()` requires explicit auth for a direct session.

- **Recommended (headless / CI):** export a personal access token as `QODER_PERSONAL_ACCESS_TOKEN` (or a custom `authEnvVar`). The provider resolves it with `accessTokenFromEnv()`.
- **Local reuse:** set `authMode: qodercli` to reuse an interactive `qodercli login` on the same machine. Not for shared infrastructure.

## Transport and brand (important)

The provider forces `transport: ProcessTransport.default` in `run.ts`. This is required for two reasons:

1. dsh can only place the child under its subprocess owner through the SDK's `spawnQoderCLIProcess` hook, which fires **only** on the process transport. The SDK's installed default is the `worker` transport (runtime in a Node worker thread), where the hook never runs and dsh cannot terminate the child.
2. The bundled worker runtime is the **global** brand (`qodercli`); on a machine logged in only to the **CN** CLI (`qoderclicn`), `qodercliAuth()` against that runtime fails with `No qodercli login found`. Routing through the process transport to the CN executable uses that executable's own native login.

Therefore set `pathToQoderCLIExecutable` to the matching executable for your deployment. On Windows CN that is e.g. `C:/Users/<you>/.qoder-cn/bin/qoderclicn/qoderclicn.exe`; omit it only if the correct-brand CLI is already first on `PATH`.

A standalone smoke test in [`smoke/`](smoke/) exercises exactly this path with no dsh packages: `cd smoke && npm install && node smoke.mjs` (add `pathToQoderCLIExecutable` as in the probe to run against the CN CLI).

## Build

```sh
pnpm install         # resolves @deepseek-ai/* peers from the dsh installation, and the Qoder SDK
pnpm run build       # tsc -> lib/ (this bundle is consumed by the dsh profile)
```

## Known limitations

Inherited from the one-shot SDK design, same as the Claude Code provider:

- One fresh process, query, and turn per run — no continuation, resume, pooling, or progress stream.
- Assistant payload is final text only; reasoning, intermediate messages, tool traffic, usage, stderr, and diffs stay product-local.
- No human approval path — `AskUserQuestion` is disabled and permission prompts are denied (except under `bypassPermissions`); MCP elicitation is declined.
- Authentication and account state remain native — the Bundle supplies the SDK/CLI but does not log in or rewrite Qoder settings.
- No wall-clock timeout or side-effect rollback — cancel long work via the caller; files changed before cancellation are not restored.
- The Qoder SDK is a fast-moving dependency (pinned `^1.0.45` here); verify `query()`/`Options`/result-shape compatibility after upgrading, as `@deepseek-ai/*` peer versions must stay consistent with the dsh installation.

## Source map

| File | Role |
|---|---|
| `src/index.ts` | Plugin entry: config schema, auth resolution, provider registration |
| `src/run.ts` | SDK query lifecycle, strict result acceptance, unattended permissions, failure taxonomy |
| `src/process.ts` | `qodercli` spawn hook under the shared subprocess managed-range owner |
| `cordis.patch.yml` | Profile layer that registers the dormant provider |

## Contract verification (static)

Every `@deepseek-ai/*` symbol this provider calls was read from the harness source, not assumed. Cross-checked against `deepseek-harness@master`:

| Symbol | Source | This provider's usage |
|---|---|---|
| `SubagentProvider` (name/capabilities/inheritsParentContext/start) | `packages/subagent/subagent/src/types.ts` | implemented by `QoderProvider` |
| `SubagentStartRequest.prompt: ContentBlock[]`, `parent`, `signal` | `types.ts` | `textTask(request.prompt)`, `request.parent.session.header.cwd` |
| `SubagentResult { output: ContentBlock[]; stopReason }` | `types.ts` | `consumeQoderQuery` returns `{output:[{type:'text'}],stopReason:'completed'}` |
| `SubagentRun` / `SubprocessRunHandleParts` | `src/types.ts`, `src/out-of-process.ts` | `subprocessRunHandle({id,result,signal,onAbort,requestCancel,teardown})` |
| `settleRunResult(RunResultSettlement)` | `src/out-of-process.ts:192` | attempt/collectOutput/collectDiagnostic/cancelled/onError/signal/onAbort |
| `resolveChildCwd(prefix, configured, parentCwd)` | `src/out-of-process.ts:147` | `resolveChildCwd('subagent-qoder', undefined, parentCwd)` |
| `assertPositiveFinite`, `NO_START_CAPABILITIES` | `src/out-of-process.ts:72,57` | config validation + capabilities |
| `SubprocessSpawnSpec` / `SubprocessHandle` / `SubprocessOutcome` | `packages/subprocess/subprocess/src/types.ts` | `qoderSpawnSpec` builds it; `ManagedQoderProcess` projects it |
| `scrubbedParentEnv(): Record<string,string>` | `packages/subprocess/subprocess/src/index.ts:66` | env base under the `env` overlay |

The Qoder-SDK side (`query`, `Options.spawnQoderCLIProcess`, `ProcessTransport`, `SDKResultMessage`, `PermissionMode`) is verified at runtime by [`smoke/`](smoke/) against SDK 1.0.45 / CLI 1.1.58. What remains unproven locally is only a full `tsc` of `src/` inside a dsh Profile (needs the `@deepseek-ai/*` peer types installed).
