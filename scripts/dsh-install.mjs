#!/usr/bin/env node
// One-shot installer: prepares the pnpm build allowance, installs this Bundle
// into a dsh Profile, and prints how to verify.
//
//   node scripts/dsh-install.mjs <profile>      # or: npm run dsh:install -- <profile>
//
// Requires: dsh on PATH, pnpm on PATH, and a built lib/ (run `npm run build`).

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageManagerBuildAllow = '@qoder-ai/qoder-agent-sdk'
const root = join(fileURLToPath(import.meta.url), '..', '..')
const profile = process.argv[2]

if (profile === undefined || profile.startsWith('-')) {
  console.error('usage: node scripts/dsh-install.mjs <profile>')
  process.exit(2)
}
if (!existsSync(join(root, 'lib', 'index.js'))) {
  console.error('lib/ is missing. Run `npm install && npm run build` in', root, 'first.')
  process.exit(1)
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileHome = join(dshHome, 'profiles', profile)
const workspaceFile = join(profileHome, 'pnpm-workspace.yaml')

// dsh resolves to a .cmd shim on Windows, so a shell is required; passing one
// pre-built string also avoids Node's DEP0190. Because the command is composed
// for a shell, the profile name is restricted to a safe charset.
if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
  console.error(`invalid profile name ${JSON.stringify(profile)}: expected [A-Za-z0-9._-]+`)
  process.exit(2)
}
const dsh = (args) => spawnSync(
  ['dsh', ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' '),
  { stdio: 'inherit', shell: true },
)

// A missing profile must be initialized from the headless template: `dsh plugin
// add` on an unknown name seeds a bare dsh-base closure, which carries neither
// the subagent seam nor the delegation tool this Bundle inserts a row for.
if (!existsSync(workspaceFile)) {
  if (existsSync(profileHome)) {
    console.error(`Profile "${profile}" exists but has no pnpm-workspace.yaml at ${workspaceFile}.`)
    console.error('Refusing to guess; add the allowBuilds key yourself and re-run.')
    process.exit(1)
  }
  console.log(`Profile "${profile}" not found; initializing from the headless template.`)
  const init = dsh(['--profile', profile, '--from-default-profile', 'headless', '--help'])
  if (init.status !== 0 || !existsSync(workspaceFile)) {
    console.error('Profile initialization failed.')
    process.exit(1)
  }
}

// pnpm 10+ blocks dependency build scripts, which would fail the install and
// leave the Bundle out of the profile's bundle stack.
const original = readFileSync(workspaceFile, 'utf8')
if (!original.includes(packageManagerBuildAllow)) {
  const patched = original.includes('allowBuilds:')
    ? original.replace(
        /(allowBuilds:\n)/,
        `$1  '${packageManagerBuildAllow}': true\n`,
      )
    : `${original.replace(/\s*$/, '')}\nallowBuilds:\n  '${packageManagerBuildAllow}': true\n`
  writeFileSync(workspaceFile, patched)
  console.log(`allowed the ${packageManagerBuildAllow} build script in ${workspaceFile}`)
} else {
  console.log('build allowance already present')
}

const fileSpec = `file:${root.split('\\').join('/')}`
const add = dsh(['plugin', '--profile', profile, 'add', fileSpec])
if (add.status !== 0) {
  console.error('dsh plugin add failed.')
  process.exit(add.status ?? 1)
}

console.log(`
Installed. Restart the profile (bundle membership is decided at start), then verify:

  dsh --profile ${profile} --dump-config | grep -A6 subagent-qoder

Expected: a "dsh-subagent-qoder" provenance comment over the provider row, and a
tool-subagent-qoder row exposing the tool "subagent_qoder". Then just ask the
agent in that profile to delegate a task to Qoder.
`)
