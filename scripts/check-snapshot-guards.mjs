// Verify generator drift checks without mutating any consumer working file.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const temp = mkdtempSync(join(root, '.snapshot-guard-check-'))
function write(relative, text) {
  const path = join(temp, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
try {
  const generator = 'scripts/sync-connect-snapshots.mjs'
  write(`iflow-connect/${generator}`, readFileSync(join(root, generator), 'utf8'))
  for (const component of ['connect', 'community', 'dsh-plugin']) {
    const folder = { connect: 'iflow-connect', community: 'iflowone-community', 'dsh-plugin': 'iflow-dsh-plugin' }[component]
    write(`${folder}/iflow.component.json`, JSON.stringify({ componentId: component }))
  }
  for (const source of ['packages/iflow-protocol/src/ard.ts', 'packages/iflow-protocol/src/agent-ref.ts', 'packages/iflow-protocol/src/a2a.ts', ...['conversation-service', 'discovery-runtime', 'agent-runtime'].map(name => `packages/iflow-adapter-sdk/src/${name}.ts`)]) {
    write(`iflow-connect/${source}`, readFileSync(join(root, source), 'utf8'))
  }
  const command = join(temp, 'iflow-connect', generator)
  const run = (check = false) => spawnSync(process.execPath, [command, ...(check ? ['--check'] : [])], { encoding: 'utf8', timeout: 30000 })
  const generation = run()
  assert.equal(generation.status, 0, generation.stdout + generation.stderr)
  const baseline = run(true)
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr)
  for (const name of ['ard', 'agent-ref', 'a2a', 'conversation-service', 'discovery-runtime', 'agent-runtime']) {
    const snapshot = join(temp, `iflow-dsh-plugin/src/generated/${name}.ts`)
    const original = readFileSync(snapshot, 'utf8')
    writeFileSync(snapshot, original + '\n// injected drift\n')
    const result = run(true)
    assert.equal(result.error, undefined)
    assert.notEqual(result.status, 0, `SURVIVED snapshot drift: ${name}`)
    assert.match(result.stderr, /Connect snapshot drift/)
    writeFileSync(snapshot, original)
    console.log(`CAUGHT: generated ${name} drift`)
  }
} finally {
  assert.equal(dirname(resolve(temp)), root)
  assert.ok(temp.startsWith(join(root, '.snapshot-guard-check-')))
  rmSync(temp, { recursive: true, force: true })
}
