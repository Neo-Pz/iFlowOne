// Only disposable module copies
// are changed; source files, git state and installed packages stay untouched.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '..')
// Keep copies under the SDK so workspace package imports resolve exactly as in
// the original module. This never substitutes an old published protocol API.
const tempRoot = join(root, 'packages/iflow-adapter-sdk')
const temp = mkdtempSync(join(tempRoot, '.connect-mutation-'))
const sdkTest = 'packages/iflow-adapter-sdk/test/connect-services.test.ts'
const protocolTest = 'packages/iflow-protocol/test/connect-protocol.test.ts'
const mutations = [
  ['exact local id', 'agent-runtime', "if (!agentId)", 'if (false)'],
  ['declared identity', 'agent-runtime', 'if (!agent || agent.agentId !== agentId || !agent.did)', 'if (!agent)'],
  ['selected identity', 'agent-runtime', 'agent.did !== expectedDid', 'false'],
  ['authority required', 'agent-runtime', 'if (!request.agentDid)', 'if (false)'],
  ['local policy', 'agent-runtime', 'if (decision.allowed !== true)', 'if (false)'],
  ['post approval identity', 'agent-runtime', 'return selectedAgent(request.agentId, request.agentDid)', 'return agent'],
  ['execution id', 'agent-runtime', 'if (!request.requestId)', 'if (false)'],
  ['status and cancellation id', 'agent-runtime', 'if (!request.attemptId)', 'if (false)'],
  ['status capability', 'agent-runtime', 'if (!runtime.getStatus)', 'if (false)'],
  ['cancel capability', 'agent-runtime', 'if (!runtime.cancel)', 'if (false)'],
  ['public consent', 'discovery-runtime', 'if (args.confirmPublic !== true)', 'if (false)'],
  ['community enabled', 'discovery-runtime', 'if (!context.enabled)', 'if (false)'],
  ['public route', 'discovery-runtime', 'if (!isPublicArdUrl(context.agentInterface?.url))', 'if (false)'],
  ['profile validation', 'discovery-runtime', 'if (!validateAgentDiscoveryProfile(profile, agent.agentId, agent.did))', 'if (false)'],
  ['publication signature', 'discovery-runtime', 'if (!event?.evidence?.signature)', 'if (false)'],
  ['registry shape', 'discovery-runtime', 'if (!isArdSearchResponse(response))', 'if (false)'],
  ['withdrawal', 'discovery-runtime', "if (args.action !== 'withdraw')", 'if (true)'],
  ['explicit runtime', 'discovery-runtime', 'runtimeKind: context.runtimeKind', "runtimeKind: 'dsh'"],
  ['explicit agent interface', 'discovery-runtime', 'supportedInterfaces: [{ ...context.agentInterface }]', "supportedInterfaces: [{ ...context.agentInterface, url: context.agentInterface.url + '/a2a' }]"],
  ['signer selection', 'conversation-service', 'if (!agent?.did || signature?.signer !== agent.did)', 'if (false)'],
  ['conversation authority pair', 'conversation-service', 'conversation.peerAgentAuthorityDid === toAgentDid', 'true'],
  ['revocation', 'conversation-service', "pairState(fromAgent.did, toAgentDid) === 'revoked'", 'false'],
  ['scoped name', 'agent-ref', 'encodeURIComponent(nodeId)', "'shared-node'"],
  ['address fields', 'agent-ref', 'if (!nodeId || !agentId)', 'if (false)'],
  ['canonical address', 'agent-ref', 'agentRef(nodeId, agentId) !== value', 'false'],
  ['artifact priority', 'a2a', 'if (artifacts) return artifacts', 'if (false) return artifacts'],
  ['rejected state', 'a2a', "'TASK_STATE_REJECTED'", "'TASK_STATE_UNKNOWN'"],
]
const envFor = { 'agent-runtime': 'IFLOW_TEST_AGENT_RUNTIME', 'conversation-service': 'IFLOW_TEST_CONVERSATION_SERVICE', 'discovery-runtime': 'IFLOW_TEST_DISCOVERY_SERVICE', 'agent-ref': 'IFLOW_TEST_AGENT_REF', a2a: 'IFLOW_TEST_A2A_PROTOCOL' }
function run(test, env = {}) {
  return spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', test], { cwd: root, encoding: 'utf8', timeout: 45000, env: { ...process.env, ...env } })
}
try {
  if (!process.argv.includes('--store-only')) {
    for (const test of [sdkTest, protocolTest]) { const result = run(test); assert.equal(result.status, 0, result.stdout + result.stderr) }
  }
  for (const [name, module, needle, replacement] of process.argv.includes('--store-only') ? [] : mutations) {
    const protocol = ['agent-ref', 'a2a'].includes(module)
    const source = readFileSync(join(root, `packages/${protocol ? 'iflow-protocol' : 'iflow-adapter-sdk'}/src/${module}.ts`), 'utf8')
    assert.ok(source.includes(needle), `mutation no longer matches: ${name}`)
    const copy = join(temp, `${module}.ts`)
    writeFileSync(copy, source.replaceAll(needle, replacement))
    const result = run(protocol ? protocolTest : sdkTest, { [envFor[module]]: copy.replaceAll('\\', '/') })
    assert.equal(result.error, undefined, result.error?.message)
    assert.notEqual(result.status, 0, `SURVIVED: ${name}`)
    assert.match(result.stdout + result.stderr, /Tests\s+\d+ failed/, `no test assertion failed: ${name}`)
    assert.match(result.stdout + result.stderr, /AssertionError|expected .*to|reject|Error: Host/, `not a behavior failure: ${name}\n${result.stdout}\n${result.stderr}`)
    assert.doesNotMatch(result.stdout + result.stderr, /Failed to load url|Cannot find module|Failed to resolve import/, `loader failed: ${name}`)
    console.log(`CAUGHT: ${name}`)
  }
} finally {
  assert.equal(dirname(resolve(temp)), tempRoot)
  assert.ok(temp.startsWith(join(tempRoot, '.connect-mutation-')))
  rmSync(temp, { recursive: true, force: true })
}

if (!process.argv.includes('--sdk-only')) {
  const siblings = dirname(root)
  const plugins = readdirSync(siblings, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(siblings, entry.name)).filter((directory) => {
    const manifest = join(directory, 'iflow.component.json')
    return existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).componentId === 'dsh-plugin'
  })
  assert.equal(plugins.length, 1, 'Expected exactly one DSH connector component')
  const plugin = plugins[0]
  const sourcePath = join(plugin, 'src/conversation/store.ts')
  const source = readFileSync(sourcePath, 'utf8')
  const portable = source.replace("from '../util/hash.ts'", `from '${pathToFileURL(join(plugin, 'src/util/hash.ts')).href}'`)
  const copies = mkdtempSync(join(plugin, '.connect-store-mutation-'))
  const storeMutations = [
    ['local authority grouping', 'conversation.localAgentAuthorityDid || null', 'null'],
    ['remote authority grouping', 'conversation.peerAgentAuthorityDid || null', 'null'],
    ['authority ambiguity', 'if (new Set(candidates.map(conversationPairKey)).size !== 1)', 'if (false)'],
    ['expected local authority', 'expectedDIDs.localAgentAuthorityDid === undefined || conversation.localAgentAuthorityDid === expectedDIDs.localAgentAuthorityDid', 'true'],
    ['expected remote authority', 'expectedDIDs.peerAgentAuthorityDid === undefined || conversation.peerAgentAuthorityDid === expectedDIDs.peerAgentAuthorityDid', 'true'],
    ['pointer pair isolation', 'conversationPairKey(candidate) === conversationPairKey(conversation)', 'candidate.localAgentId === conversation.localAgentId && candidate.peerAgentId === conversation.peerAgentId'],
    ['activation authority', 'if (!matchesExpectedAuthorities(conversation, expectedDIDs))', 'if (false)'],
    ['list authority', 'if (!matchesExpectedAuthorities(candidate, expectedDIDs))', 'if (false)'],
  ]
  function runStore(path) {
    return spawnSync(process.execPath, ['--test', 'test/conversation-store.test.mjs'], { cwd: plugin, encoding: 'utf8', timeout: 30000, env: { ...process.env, IFLOW_TEST_CONVERSATION_STORE: path } })
  }
  try {
    const baseline = runStore(sourcePath)
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr)
    for (const [name, needle, replacement] of storeMutations) {
      assert.ok(portable.includes(needle), `mutation no longer matches: ${name}`)
      const path = join(copies, 'store.ts')
      writeFileSync(path, portable.replaceAll(needle, replacement))
      const result = runStore(path)
      assert.equal(result.error, undefined)
      assert.notEqual(result.status, 0, `SURVIVED: ${name}`)
      assert.match(result.stdout, /failureType: 'testCodeFailure'/)
      assert.match(result.stdout, /# cancelled 0/)
      assert.doesNotMatch(result.stdout + result.stderr, /ERR_MODULE_NOT_FOUND|SyntaxError|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/)
      console.log(`CAUGHT: private store ${name}`)
    }
  } finally {
    assert.equal(dirname(resolve(copies)), plugin)
    assert.ok(copies.startsWith(join(plugin, '.connect-store-mutation-')))
    rmSync(copies, { recursive: true, force: true })
  }
}
