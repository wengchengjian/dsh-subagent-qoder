// Standalone smoke test: proves the exact Qoder-SDK surface that
// dsh-subagent-qoder/src/run.ts depends on — query() over ProcessTransport with
// unattended options, strict result consumption (successfulResult), and that a
// real final answer comes back. No dsh packages involved. Single query pass.
//
// Run:
//   node smoke.mjs "optional custom prompt"
// Env:
//   QODER_PERSONAL_ACCESS_TOKEN  token auth; else reuses local login (qodercliAuth)
//   QODER_CLI_PATH               absolute path to the matching-CLI executable.
//                                REQUIRED on a CN-only machine: the SDK's default
//                                `worker` runtime is the global brand and has no
//                                login here. Passing this forces ProcessTransport,
//                                which is also what dsh needs to own the child.

import { spawn } from 'node:child_process'
import { query, ProcessTransport, qodercliAuth, accessTokenFromEnv } from '@qoder-ai/qoder-agent-sdk'

// --- mirror of run.ts: successfulResult() ---------------------------------
function successfulResult(message) {
  if (message.subtype !== 'success') {
    const errors = Array.isArray(message.errors) ? message.errors.join('; ') : ''
    throw new Error(`Qoder result subtype=${message.subtype}${errors ? `: ${errors}` : ''}`)
  }
  if (message.is_error || !message.result?.trim()) {
    throw new Error('Qoder result marked error or blank final text')
  }
  return message.result
}

const auth = process.env.QODER_PERSONAL_ACCESS_TOKEN ? accessTokenFromEnv() : qodercliAuth()
const cli = process.env.QODER_CLI_PATH
const prompt = process.argv[2] || 'Reply with exactly this and nothing else: QODER_OK'

const options = {
  auth,
  cwd: process.cwd(),
  persistSession: false,
  permissionMode: 'dontAsk',
  disallowedTools: ['AskUserQuestion'],
  maxTurns: 3,
  canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'unattended smoke test' }),
  onElicitation: () => Promise.resolve({ action: 'decline' }),
}
if (cli) {
  options.transport = ProcessTransport.default
  options.pathToQoderCLIExecutable = cli
  options.spawnQoderCLIProcess = (o) =>
    spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'inherit'] })
}

console.log(`[smoke] auth=${auth.type} transport=${cli ? 'process' : 'default'} cli=${cli ?? '(sdk-resolved)'}`)

const q = query({ prompt, options })
let answer
let permDenials = 0
let meta = {}
try {
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      meta.session = m.session_id
      console.log(`[init] session=${m.session_id} model=${m.model ?? '?'}`)
    } else if (m.type === 'system' && m.subtype === 'permission_denied') {
      permDenials++
      console.log(`[perm-denied] ${m.tool_name}`)
    } else if (m.type === 'result') {
      answer = successfulResult(m) // throws on non-success / blank, exactly like run.ts
      meta.cost = m.total_cost_usd
      meta.turns = m.num_turns
    }
  }
  console.log(`\n[final-text] ${JSON.stringify(answer)}`)
  console.log(`[verify] successfulResult() accepted strict success + non-empty text`)
  console.log(`[verify] contains QODER_OK marker: ${answer?.includes('QODER_OK')}`)
  console.log(`[cost] $${meta.cost} over ${meta.turns} turn(s); perm-denials=${permDenials}`)
  console.log(`\nPASS: Qoder query→result link works end-to-end`)
} catch (e) {
  console.error(`\nFAIL: ${e.message}`)
  console.error('[hint] on a CN-only machine, set QODER_CLI_PATH to qoderclicn(.exe)')
  process.exitCode = answer === undefined ? 2 : 1
} finally {
  try { await q.close() } catch { /* best-effort teardown */ }
}
