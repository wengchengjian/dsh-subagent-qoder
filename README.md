# dsh-subagent-qoder

One-shot Qoder subagent provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), built over the official [`@qoder-ai/qoder-agent-sdk`](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk). It is the Qoder sibling of `@deepseek-ai/dsh-subagent-claude-code`: a delegated task runs as a fresh, unattended `qodercli` session in the parent Session's workspace and returns only its final answer (or a safe failure diagnostic). Reasoning, tool traffic, stderr, and workspace diffs never enter the parent Session.

> This is an **out-of-tree Profile Bundle**, not a Qoder plugin. It plugs into dsh's subagent seam (`ctx.subagents`) and is exposed to the model through dsh's `@deepseek-ai/dsh-tool-subagent` tool row.

## When to use

Mount it when a delegation should run as a genuine Qoder CLI session with isolated context, and one-shot semantics (no continuation, resume, or pooling) are acceptable. Native Qoder settings and authentication remain authoritative; the Profile chooses the model, environment, permission mode, and auth source.

## Install

One command, from a built checkout of this repository:

```sh
npm install && npm run build
node scripts/dsh-install.mjs <profile>     # or: npm run dsh:install -- <profile>
```

The script initializes a missing Profile from the `headless` template (a bare `dsh plugin add` on an unknown name seeds only `dsh-base`, whose closure lacks the subagent seam and delegation tool this Bundle inserts a row for), allows the Qoder SDK's build script past pnpm's gate, installs the Bundle, and prints a verification command. It is idempotent; restart the Profile afterwards, since bundle membership is decided at start.

To do it by hand instead:

```sh
dsh plugin --profile <name> add ../dsh-subagent-qoder
```

If pnpm reports `ERR_PNPM_IGNORED_BUILDS` for `@qoder-ai/qoder-agent-sdk`, set its `allowBuilds` key to `true` in that Profile's `pnpm-workspace.yaml` (pnpm writes the placeholder) and re-run — see [Verified install gotchas](#verified-install-gotchas). Installing controls Host availability, not model permission.

## Configure the provider

**Zero configuration is required.** The Bundle's own `cordis.patch.yml` registers the dormant provider *and* inserts the `subagent_qoder` tool row, and the provider discovers the `qodercli` executable by itself (`QODER_CLI_PATH` → `PATH` → `~/.qoder-cn/bin/qoderclicn` → `~/.qoder/bin/qodercli`). Set any of these in a provider row on the Profile's `cordis.patch.yml` only to override a default:

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `qoder` | Registry name on `ctx.subagents`; each mounted instance needs a unique value |
| `model` | native Qoder settings | Optional model fixed for every run from this instance |
| `authMode` | `qodercli` | `qodercli` reuses the local `qodercli login`; `env` reads a personal access token from `authEnvVar` (use this for CI/headless hosts) |
| `authEnvVar` | `QODER_PERSONAL_ACCESS_TOKEN` | Token variable when `authMode: env` |
| `env` | `{}` | Child environment layered over the credential-scrubbed parent environment |
| `pathToQoderCLIExecutable` | auto-discovered | Absolute path override; see the discovery order above |
| `proxy` | discovered | Proxy URL for the child's own outbound traffic; see [Proxy](#proxy) |
| `useSystemProxy` | `true` | Fall back to `HTTP(S)_PROXY` then the OS system proxy when `proxy` is omitted |
| `permissionMode` | `yolo` | Non-interactive policy fixed for every run from this instance |
| `disposeGraceMs` | `3000` | Grace between managed-range termination tiers |

## Proxy

The Qoder SDK does **not** discover a proxy from the inherited environment — `Options.proxy` documents that an omitted value makes the child "connect directly and does not discover a proxy from the inherited environment". So passing `HTTP_PROXY` to the parent process does not reach the child; the provider passes it explicitly.

Resolution order: `proxy` config → `HTTP(S)_PROXY`/`https_proxy`/`http_proxy` → operating-system setting → direct. On Windows the system setting is read from `HKCU\...\Internet Settings` (`ProxyEnable`/`ProxyServer`) and a bare `host:port` is normalized to `http://host:port`; a per-protocol list (`http=h:1;https=h:1`) is left alone rather than guessed, so set `proxy` explicitly in that case. macOS and Linux have no OS-level probe here — rely on the environment variables or `proxy`. Verified on this machine: with nothing configured and no env var, discovery yields `http://127.0.0.1:7897`; explicit config wins; `useSystemProxy: false` forces direct.

A child that must not inherit a proxy uses `useSystemProxy: false` — the setting has no other "off" value, because an empty string is rejected by the schema.

`permissionMode` values and their unattended behavior:

| Value | Behavior |
|---|---|
| `yolo` **(default)** | Full authority: every operation runs with no permission gate and no human in the loop |
| `dontAsk` | Deny anything not already authorized instead of prompting |
| `acceptEdits` | Accept file edits; remaining permission prompts are denied by the unattended callback |
| `auto` | Let Qoder's native classifier allow or deny permission requests |
| `plan` | Run in planning mode, deny execution approval, return the plan as the final answer |
| `bypassPermissions` | Same effective authority as `yolo`, different spelling |

`yolo` and `bypassPermissions` are one mode on the Qoder side, not a ladder: the SDK maps `yolo` to the CLI's `--yolo` flag and deliberately suppresses `--dangerously-skip-permissions` for it (`allowDangerouslySkipPermissions && permissionMode !== "yolo"`), while both normalize to `bypass_permissions` on the control path. Both are treated as full-access here, which chiefly means **the deny-by-default `canUseTool` callback is not installed** — installing it would silently neutralize the mode.

> **Understand the default before changing it.** This provider has no approval channel at all: `AskUserQuestion` is disallowed and no human can intervene mid-run. So the `yolo` default means an autonomous Qoder agent holds write and shell authority over the delegating Session's real workspace, driven by text a model composed. Nothing confines it here — dsh's sandbox backends (bwrap, Landlock, Seatbelt) are Linux/macOS, so on Windows there is no filesystem or process confinement around the child. Anything the child reads (a source file, a web page, a tool result) is an instruction-injection path straight into that authority. Set `permissionMode: acceptEdits`, `auto`, or `dontAsk` in the provider row to tighten it, or mount a second provider row with its own `toolName` so a low-privilege tool is the one the model reaches for by default.

Credential-shaped ambient variables are removed before the `env` overlay, so a token intended for the child must be supplied via `authMode: env` or placed explicitly in `env`.

## The delegation tool

The Bundle's `cordis.patch.yml` inserts the model-facing row itself, so after installing there is nothing to compose — the tool is named `subagent_qoder`, and it accepts only `{ description, prompt, run_in_background }`. The model cannot choose the provider's model, permission mode, or workspace; those are fixed by the provider row. Each delegation row names one provider and needs its own `toolName`, which is why a second, differently-privileged instance is a second pair of rows rather than a call argument:

```yaml
# Tighten the default, opt out, or add a second instance.
- id: subagent-qoder
  config:
    permissionMode: acceptEdits          # opt in to a tighter policy than `yolo`

- id: tool-subagent-qoder
  disable: true                          # hide subagent_qoder from this Profile

- insert:
    - id: subagent-qoder-safe
      name: 'dsh-subagent-qoder'
      config:
        providerName: qoder-safe
        permissionMode: acceptEdits
- insert:
    - id: tool-subagent-qoder-safe
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: qoder-safe
        toolName: subagent_qoder_safe
        backgroundMode: one-shot
        maxDepth: provider-managed
```

The inserted row requires `@deepseek-ai/dsh-tool-subagent`, plus `@deepseek-ai/dsh-jobs-local` and `@deepseek-ai/dsh-tool-jobs` for `run_in_background`, to be in the Profile's closure. The `headless` and `web` templates already carry all three; a bare `dsh-base` Profile does not, which is why the installer initializes missing Profiles from `headless`.

`maxDepth: provider-managed` is **required**, not cosmetic: this provider advertises no `depthLimit` capability, and omitting the field fails the whole Profile at boot with `tool-subagent: provider "qoder" cannot enforce maxDepth (no depthLimit capability)`. The check runs when the provider registers, so it is not visible to a unit-level `provider.start()` test — only to a real boot.

A foreground call returns the final Qoder answer or an error with the stop reason and a safe diagnostic. A background call returns a parent-owned Job id for `job_output` / `job_kill`.

**Background jobs do not notify a one-shot run.** Measured on the `headless` profile: with the session alive across multiple steps and a long generation, no completion notice arrived and no notice-driven turn was scheduled; and once the turn ended, `job_output <id>` returned `unknown job` with `job_list` empty, because the Jobs registry is per-process and exiting also tears the child down. So in a one-shot run either delegate in the foreground, or collect with `job_output` (`wait: true`) inside the same turn. Whether an interactive Web/desktop session receives the proactive notice was not tested here — do not assume it.

## Authentication

`query()` requires explicit auth for a direct session.

- **Local reuse (default):** `authMode: qodercli` reuses an interactive `qodercli login` on the same machine, which is why the zero-config path works on a developer workstation. Not for shared infrastructure.
- **Headless / CI:** set `authMode: env` and export a personal access token as `QODER_PERSONAL_ACCESS_TOKEN` (or a custom `authEnvVar`); the provider resolves it with `accessTokenFromEnv()`.

## Transport and brand (important)

The provider forces `transport: ProcessTransport.default` in `run.ts`. This is required for two reasons:

1. dsh can only place the child under its subprocess owner through the SDK's `spawnQoderCLIProcess` hook, which fires **only** on the process transport. The SDK's installed default is the `worker` transport (runtime in a Node worker thread), where the hook never runs and dsh cannot terminate the child.
2. The bundled worker runtime is the **global** brand (`qodercli`); on a machine logged in only to the **CN** CLI (`qoderclicn`), `qodercliAuth()` against that runtime fails with `No qodercli login found`. Routing through the process transport to the CN executable uses that executable's own native login.

The provider therefore resolves a CLI executable itself — `QODER_CLI_PATH`, then `qoderclicn`/`qodercli` on `PATH`, then `~/.qoder-cn/bin/qoderclicn` and `~/.qoder/bin/qodercli`. Override with `pathToQoderCLIExecutable` when the CLI lives elsewhere; if nothing is found the provider logs the search order at Profile start rather than failing silently on the first delegation.

A standalone smoke test in [`smoke/`](smoke/) exercises the Qoder-SDK path with no dsh packages: `cd smoke && npm install && QODER_CLI_PATH=<cli> node smoke.mjs`.

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
- The Qoder SDK is a fast-moving dependency (pinned `^1.0.45` here); verify `query()`/`Options`/result-shape compatibility after upgrading. The dsh side requires `@deepseek-ai/dsh-subagent >= 0.1.6-alpha.2` for the out-of-process helpers.

## Source map

| File | Role |
|---|---|
| `src/index.ts` | Plugin entry: config schema, auth resolution, provider registration |
| `src/run.ts` | SDK query lifecycle, strict result acceptance, unattended permissions, failure taxonomy |
| `src/process.ts` | `qodercli` spawn hook under the shared subprocess managed-range owner |
| `cordis.patch.yml` | Profile layer that registers the dormant provider |

## Verification record

All of the following was run on a real machine (Windows, `dsh 0.1.6-alpha.2`, Qoder SDK 1.0.45 driving `qoderclicn 1.1.58`).

| Step | Command / method | Result |
|---|---|---|
| SDK link only | `smoke/smoke.mjs` with `QODER_CLI_PATH` | `result: "QODER_OK"`, spawn hook fired once |
| Real type build | `tsc -p tsconfig.json` against installed `@deepseek-ai/*@0.1.6-alpha.2` peer types | exit 0; emits `lib/*.js` + `lib/types/*.d.ts`; `./run.ts` specifiers rewritten to `./run.js` |
| Bundle install | `dsh plugin --profile <p> add file:<checkout>` | installed; Qoder SDK postinstall fetched the win32-x64 worker runtime with checksum |
| Patch composition | `dsh --profile <p> --dump-config` | provider row appears with provenance `# == dsh-subagent-qoder` |
| Plugin contract | `import('dsh-subagent-qoder')` in the profile | `name=subagent-qoder`, `inject=["subagents","subprocess"]`, `apply`/`Config` present |
| Delegation end-to-end | `provider.start()` with real `settleRunResult`/`subprocessRunHandle`/`resolveChildCwd` + a `SubprocessHandle` shim | `stopReason=completed`, `output=[{type:'text',text:'QODER_OK'}]`, `localAgent=undefined` |
| **Full parent-model path** | `dsh --profile <p> --json "<ask it to call subagent_qoder>"` with the outbound proxy set | `tool_call tool=subagent_qoder` → `tool_result status=completed result="QODER_E2E_OK"` → `turn_end kind=completed`, `final="QODER_E2E_OK"`, 12608 in / 86 out tokens |

The last row closes what a Profile boot cannot show: the `tool_call` event proves the delegation tool reached the parent model's tool list and the model chose to invoke it, and the `tool_result` is the child Qoder session's final text propagated back into the parent's answer.

| Background / Job path | `subagent_qoder` with `run_in_background: true`, then `job_output` | first `tool_result` = `started background subagent job subagent-1`; then `job_output {job_id:"subagent-1", wait:true}` → `QODER_BG_OK\n[status: completed]`; `final = QODER_BG_OK` |

`job_kill` was not exercised. Note also that the parent's own `thinking` events appear in the parent stream while the child's reasoning never does — the isolation direction is as designed.

| `yolo` default grants write | Provider row with `permissionMode` **omitted**, delegation asked to create `YOLO_PROOF.txt` containing `WRITE_OK` | `tool_result` reported the path; **on disk** the file existed, 8 bytes, content `WRITE_OK` (the parent then re-read it with its own `read` tool). A restrictive default would have denied the write |
| **One-command, zero-config** | `node scripts/dsh-install.mjs <new-profile>` only; provider row carries **no** config, so the CLI path is auto-discovered and `authMode` defaults to `qodercli` | `--dump-config` composed both rows from the Bundle patch; a delegation created `ONECLICK.txt` and the bytes (`ZERO_CONFIG`) were confirmed on disk |
| Proxy discovery | `resolveProxy()` across five input combinations, plus a live delegation with `Options.proxy` set | no config/no env → `http://127.0.0.1:7897` from the registry; explicit wins; `host:port` normalized with scheme; `useSystemProxy: false` → direct; env beats OS. Child inference succeeded through the explicit proxy |
| No background notice | `run_in_background: true` with the session kept alive for a 300-word generation, then a resumed session | no notice and no notice-driven turn in either case; after the first process exited, `job_output subagent-1` → `unknown job`, `job_list` → `(no background jobs)` |

### Verified install gotchas

1. **Requires `dsh >= 0.1.6-alpha.2`.** The `0.1.5-rc.x` line has no `out-of-process` module, so `settleRunResult`, `subprocessRunHandle`, `resolveChildCwd`, `NO_START_CAPABILITIES` and `assertPositiveFinite` are not exported and this provider cannot build. Note that `@deepseek-ai/dsh-*` publish under `latest` an old `0.0.1-rc.1`; the usable train is the `alpha` dist-tag.
2. **pnpm blocks the Qoder SDK build script.** A bare `dsh plugin add` fails with `ERR_PNPM_IGNORED_BUILDS: @qoder-ai/qoder-agent-sdk`. `scripts/dsh-install.mjs` sets the allowance for you; by hand, add it to the Profile's `pnpm-workspace.yaml` (pnpm writes the placeholder to fill in) and re-run:
   ```yaml
   allowBuilds:
     '@qoder-ai/qoder-agent-sdk': true
   ```
3. **Check the bundle stack after a failed install.** `dsh plugin add` reconciles `dsh.profile.bundles` on success, and a clean `file:` install does join it. But if the run fails partway (e.g. the build-script gate above), the dependency can land in `dependencies` without joining the bundle list — re-run the add after fixing, or add the name to `dsh.profile.bundles` yourself, then restart the Profile.
4. **A missing Profile must come from a template that has the seam.** `dsh plugin add` on an unknown name initializes it with `dsh-base` alone, whose closure lacks `@deepseek-ai/dsh-tool-subagent`, so the Bundle's inserted tool row cannot resolve. The installer initializes from `headless` instead; installing into an existing `web`/`desktop`-style Profile needs no such care as long as that Profile already carries the seam.
5. **The process transport needs a discoverable CLI.** The SDK's default package runtime is `Worker`, and its postinstall skips the bundled CLI binary ("Set `QODER_INSTALL_BUNDLED_CLI=1` to install the process fallback as well"). Discovery covers `QODER_CLI_PATH`, `PATH`, and the default `~/.qoder-cn/bin/qoderclicn` / `~/.qoder/bin/qodercli`; on a CN machine the discovered executable must be the **CN** one, because the global-brand worker reports `No qodercli login found`.

### Deviation from the Claude Code provider

`query()` in the Qoder SDK starts its transport **lazily**: nothing calls `spawnQoderCLIProcess` until the session is driven. `run.ts` therefore awaits `Query.initializationResult()` before requiring the managed child handle. Without this, publication fails with `SDK did not publish a controllable qodercli process`. The provider also adds `auth` (Qoder requires it for direct `query()` sessions) and omits the SDK-absent `onUserDialog` / `supportedDialogKinds` options.

### Parent-model reachability

Whether a delegation turn completes depends entirely on the parent side being able to reach its own configured provider — nothing this plugin controls. On the machine above, the globally active provider pointed at a host reachable only through a local HTTP proxy: a bare run stalled in step 1 with `inputTokens: 0` and `TIMEOUT`, while `HTTP_PROXY`/`HTTPS_PROXY` pointing at the proxy produced the successful turn recorded above. dsh resolves the outbound proxy from the launch environment before any entry mounts, so exporting those variables is enough; a provider whose endpoint is directly reachable needs no such setting.

A stalled `step_end` with zero tokens is therefore a parent-model symptom, not a subagent failure — check the provider endpoint before suspecting this Bundle.
