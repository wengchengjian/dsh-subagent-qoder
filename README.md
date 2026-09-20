# dsh-subagent-qoder

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) Profile Bundle that runs a delegated task as a fresh, unattended **Qoder CLI** session in the parent Session's workspace. It is the Qoder sibling of `@deepseek-ai/dsh-subagent-codex` and `@deepseek-ai/dsh-subagent-claude-code`.

Each delegation spawns the real `qoderclicn`/`qodercli` executable, submits one self-contained text task, and returns only its final answer (or a safe failure diagnostic). Reasoning, tool traffic, hook chatter, stderr, usage, and workspace diffs never enter the parent Session.

> An out-of-tree Profile Bundle, not a Qoder plugin. It plugs into dsh's subagent seam (`ctx.subagents`) and is exposed to the model through dsh's `@deepseek-ai/dsh-tool-subagent` tool row.

## Why it depends on nothing

The Qoder Agent SDK is the obvious route, and it is the one thing that made installation painful: the SDK ships a `postinstall` that downloads a runtime this provider never uses, and pnpm 10+ blocks third-party build scripts — so `dsh plugin add` failed until the operator preset `allowBuilds` in the Profile's `pnpm-workspace.yaml`.

Instead the provider speaks `qodercli`'s own protocol directly (`--print --output-format stream-json`), the same shape the official Codex provider uses for its app-server. That means one install command, no build scripts, and the child sitting straight under dsh's subprocess owner.

## Install

```sh
dsh plugin --profile <profile> add github:wengchengjian/dsh-subagent-qoder
```

Then restart that Profile — bundle membership is decided at start.

Installing from a local checkout works too (`add ../dsh-subagent-qoder`), and `lib/` is committed so neither route needs a build.

**A brand-new Profile needs the template first.** `dsh plugin add` on an unknown name initializes it with `dsh-base` alone, whose closure has no subagent seam and no delegation tool, so the row this Bundle inserts cannot resolve:

```sh
dsh --profile <name> --from-default-profile headless   # or web
dsh plugin --profile <name> add github:wengchengjian/dsh-subagent-qoder
```

An existing `headless`/`web`-style Profile already carries the seam, `dsh-jobs-local`, and `dsh-tool-jobs`, so the single install command is enough.

## Configuration

Defaults are chosen so that **installing is the whole setup** — an empty provider row is valid. Override in the Profile's `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `qoder` | Registry name on `ctx.subagents`; each mounted instance needs a unique value |
| `model` | native Qoder settings | Optional model override passed as `--model` |
| `permissionMode` | `yolo` | Non-interactive policy fixed for every run from this instance |
| `pathToQoderCLIExecutable` | discovered | Absolute CLI path; see [Finding the CLI](#finding-the-cli) |
| `proxy` | discovered | Exported to the child as `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` |
| `useSystemProxy` | `true` | Fall back to inherited `HTTP(S)_PROXY`, then the OS setting |
| `env` | `{}` | Child environment layered over the credential-scrubbed parent environment |
| `disposeGraceMs` | `3000` | Grace between managed-range termination tiers |

## Permission

`permissionMode` accepts exactly what `qoderclicn` can be told on argv:

| Value | Flags | Behavior |
|---|---|---|
| `yolo` **(default)** | `--yolo` | Full authority; nothing is surfaced or awaited |
| `bypassPermissions` | `--permission-mode bypass_permissions` | Same authority as `yolo` for the operations measured below |
| `acceptEdits` | `--permission-mode accept_edits` | File writes auto-accepted; shell commands denied |
| `auto` | `--permission-mode auto` | Qoder's native classifier decides (not measured) |
| `dontAsk` | `--permission-mode dont_ask` | Denies both file writes and shell commands |

Measured authority, one `qoderclicn --print` run each, judged by what reached disk:

| Mode | Wrote a file | Ran a shell command |
|---|---|---|
| `--yolo` | yes | yes (`BASH_PROBE.txt` contained `ran`) |
| `--permission-mode bypass_permissions` | yes | not measured |
| `--dangerously-skip-permissions` | yes | not measured |
| `--permission-mode accept_edits` | yes | **no** — replied `denied`, no file created |
| `--permission-mode dont_ask` | **no** — replied "Could not complete — writes are blocked" | no |

Nothing hung: a denied operation is reported in the final text, so a restrictive mode degrades the answer rather than stalling the run.

`--yolo` is not listed in `qoderclicn --help`; it is an undocumented alias that the SDK also treats as equivalent (`yolo` and `bypassPermissions` both normalize to `bypass_permissions`), while `--dangerously-skip-permissions` is a separate documented switch. All three granted the writes tested here; equivalence beyond those operations is not claimed.

`plan` is deliberately **not** offered: the CLI's `--permission-mode` enum has no `plan` member, and this provider has no control channel to enter it.

**`acceptEdits` is the measured sweet spot for code-editing delegations** — it keeps the file-write authority such a task needs and drops the shell authority it usually does not, at no cost to completion (denials are reported, not hung).

> **Understand the default before changing it.** There is no approval channel here at all — a child runs unattended. So `yolo` means an autonomous Qoder agent holds write and shell authority over the delegating Session's real workspace, acting on text a model composed. dsh's sandbox backends (bwrap, Landlock, Seatbelt) are Linux/macOS, so on Windows nothing confines it. Anything the child reads is an instruction-injection path into that authority. Set `permissionMode: acceptEdits`, `auto`, or `dontAsk` to tighten it, or mount a second provider row with its own `toolName` so a low-privilege tool is the one reached by default.

## The delegation tool

The Bundle's `cordis.patch.yml` inserts the model-facing row itself, so after installing there is nothing to compose. The tool is `subagent_qoder` and it accepts only `{ description, prompt, run_in_background }` — the model cannot choose the child's model, permission mode, or workspace, because those are fixed by the provider row.

```yaml
# Optional overrides in the Profile's own cordis.patch.yml:
- id: subagent-qoder
  config:
    permissionMode: acceptEdits

- id: tool-subagent-qoder
  disable: true                     # hide subagent_qoder from this Profile
```

`maxDepth: provider-managed` on that row is **required**, not cosmetic: this provider advertises no `depthLimit` capability, and omitting it fails the whole Profile at boot with `tool-subagent: provider "qoder" cannot enforce maxDepth`. The assertion runs when the provider registers, so a unit-level `provider.start()` test cannot surface it — only a real boot.

## How a delegation runs

```
parent model tool_call(subagent_qoder {description, prompt})
  → dsh-tool-subagent        builds SubagentStartRequest (prompt blocks, label, parent, signal)
  → dsh-subagent             validates capabilities, resolves the descriptor
  → QoderProvider.start()    resolveChildCwd() → spawn via ctx.subprocess
  → qoderclicn --print --output-format stream-json --no-session-persistence --yolo
                             task text written to stdin, stdin closed
  ← JSONL: system/assistant/… ignored; only type:"result" is read
  → SubagentResult { output:[{type:'text',…}], stopReason:'completed' }
```

Only a strict terminal result completes a run: `subtype === 'success'`, `is_error` false, and non-blank text. Anything else — a non-success subtype, no result before exit, a failed spawn — settles as `stopReason: 'error'` with a fixed-category diagnostic (`spawn` / `run` / `process` / `teardown`, capped at 4096 bytes). Cancellation arrives through the request's `AbortSignal`, which terminates the managed range and settles `aborted`.

Because the task travels over stdin rather than argv, a long or quote-heavy delegation prompt cannot hit a command-line limit or need shell escaping.

### Finding the CLI

`QODER_CLI_PATH` → `qoderclicn`/`qodercli` on `PATH` → `~/.qoder-cn/bin/qoderclicn` → `~/.qoder/bin/qodercli`. Nothing found is logged at Profile start rather than failing silently on the first delegation. Set `pathToQoderCLIExecutable` when the executable lives elsewhere.

### Authentication

`qoderclicn` has no token flag, so authentication and account state are exactly the executable's own login — same contract as the Codex and Claude Code providers. On a shared or headless host, sign that executable in (`qoderclicn login`) or run the Profile as an account that already has a login; the provider never creates, stores, or rewrites credentials.

### Proxy

`proxy` is exported to the child as `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY`; with it omitted, inherited proxy variables win, then the Windows per-user system proxy from `HKCU\...\Internet Settings` (a bare `host:port` is normalized to `http://host:port`; a per-protocol list is left alone rather than guessed). `useSystemProxy: false` opts out. macOS and Linux have no OS-level probe — use `proxy` or the environment. Whether `qoderclicn` honors those variables is **unverified on this machine**, because its endpoints are directly reachable here; treat it as pass-through, not as a tested path.

## Background jobs and completion notices

`run_in_background: true` returns a parent-owned Job id; `job_output` retrieves the child's final text and `job_kill` cancels.

**A one-shot run receives no completion notice.** Measured on the `headless` profile: with the session kept alive across several steps and a long generation, no notice arrived and no notice-driven turn was scheduled; and once the process exited, `job_output <id>` returned `unknown job` with `job_list` empty — the Jobs registry is per-process, and exiting tears the child down too. So in a one-shot run, delegate in the foreground or collect with `job_output` inside the same turn. Whether a persistent Web/desktop session receives the proactive notice was not tested — do not assume it.

## Known limitations

- One fresh process, one turn, one result per run — no continuation, resume, pooling, or progress stream.
- The task must be text blocks only; images and other block types are rejected.
- Final assistant text only; reasoning, intermediate messages, tool traffic, usage, stderr, and diffs stay product-local.
- No human approval path, by design; permission decisions are made by the mode above with no way to ask.
- No `plan` mode (argv cannot express it) and no per-call model or permission choice.
- Authentication and account state remain native to the executable.
- No wall-clock timeout and no side-effect rollback — cancel long work; files changed before cancellation are not restored.
- Requires the Profile closure to include `@deepseek-ai/dsh-tool-subagent` (plus the jobs packages for `run_in_background`).

## Source map

| File | Role |
|---|---|
| `src/index.ts` | Cordis plugin entry: config schema, CLI and proxy discovery, provider registration |
| `src/run.ts` | One-shot lifecycle: spawn, stdin, strict result acceptance, cancellation, teardown, failure taxonomy |
| `src/wire.ts` | Dependency-free protocol: argv construction, permission flags, JSONL line buffering, result parsing |
| `cordis.patch.yml` | Profile layer registering the provider and inserting the delegation tool row |
| `lib/` | Committed build output, so installs need no compile step |

Rebuild after editing `src/`: `npm install --no-save @deepseek-ai/<peers>@alpha typescript @types/node && npm run build` (peers are `cordis`, `schemastery`, `dsh-brand`, `dsh-llm`, `dsh-session`, `dsh-subagent`, `dsh-subprocess`, `dsh-timeout`), then commit `lib/`.

## Verification record

Everything below ran on a real Windows machine with `dsh 0.1.6-alpha.2`, `qoderclicn 1.1.58`.

| Step | Result |
|---|---|
| Wire protocol, no SDK | `--print --output-format stream-json` emitted `system/init`, `assistant`, then `result/success` with `is_error=false`, `result="WIRE_OK"` |
| Permission semantics | `--yolo` created a file (verified on disk); `dont_ask` answered `denied` without hanging and created nothing |
| Real type build | `tsc` exit 0 against installed `@deepseek-ai/*@0.1.6-alpha.2` peer types; emits `lib/*.js` + `lib/types/*.d.ts` |
| One-command install | `dsh plugin --profile <p> add github:wengchengjian/dsh-subagent-qoder` → `Packages: +1`, joined `dsh.profile.bundles`, **no** build-script gate |
| Patch composition | `--dump-config` shows the provider row plus `tool-subagent-qoder` with `toolName: subagent_qoder`, from an empty provider config |
| Live delegation after the wire rewrite | `tool_call subagent_qoder` → `tool_result completed` → the child created `WIRE_RUN.txt`, bytes `WIRE_LIVE` confirmed on disk and re-read by the parent; `turn_end kind=completed` |
| Version floor | `@deepseek-ai/dsh-subagent@0.1.5-rc.2` has no `out-of-process` module (`settleRunResult`, `subprocessRunHandle`, `resolveChildCwd`, `NO_START_CAPABILITIES`, `assertPositiveFinite`), so peers are pinned `>=0.1.6-alpha.2`. Note `@deepseek-ai/dsh-*` publish an old `0.0.1-rc.1` under `latest`; the usable train is the `alpha` dist-tag |

## Install gotchas, measured

1. **`allowBuilds` is no longer needed** — nothing in this Bundle has a build script. If an older checkout of this repo asked for it, that requirement is gone.
2. **A bundle-stack miss follows a failed install.** `dsh plugin add` reconciles `dsh.profile.bundles` on success; if the run fails partway the dependency can land in `dependencies` without joining the list. Re-run, or add the name to `dsh.profile.bundles`, then restart.
3. **A stalled `step_end` with zero tokens is a parent-provider symptom**, not a subagent failure: the delegating model could not reach its own provider. dsh resolves the outbound proxy from the launch environment, so exporting `HTTP_PROXY`/`HTTPS_PROXY` is the fix when the configured provider endpoint needs one.
