// Mutations run exclusively in disposable copies; dirty sources and installed plugins are untouched.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
const core = resolve(import.meta.dirname, '..')
const plugin = resolve(core, '../iflow-dsh-plugin')
const community = resolve(core, '../iflowone-community/apps/iflowone-community')
const web = resolve(core, '../iflowone-community/apps/iflowone-web')
const contract = readFileSync(join(core, 'packages/iflow-protocol/src/ard.ts'), 'utf8')
const runtimePath = join(plugin, 'src/generated/discovery-runtime.ts')
const runtime = readFileSync(runtimePath, 'utf8').replace(/\r\n/g, '\n')
const workerPath = join(community, 'src/index.ts')
const worker = readFileSync(workerPath, 'utf8')
const ardPath = join(community, 'src/ard.ts')
const ard = readFileSync(ardPath, 'utf8').replace(/\r\n/g, '\n')
const catalogPath = join(community, 'src/ard-catalog.ts')
const catalogSource = readFileSync(catalogPath, 'utf8').replace(/\r\n/g, '\n')
const copies = []
function temp(root) { const dir = mkdtempSync(join(root, '.ard-guard-check-')); copies.push([root, dir]); return dir }
function localImports(source, path) {
  return source.replace(/from '(\.\.?\/[^']+)\.(?:js|ts)'/g, (_whole, relative) => `from '${pathToFileURL(resolve(dirname(path), relative + '.ts')).href}'`)
}
function copyWorker(tempDir, { ardBody = ard, catalogBody = catalogSource, contractCopy } = {}) {
  const catalogCopy = join(tempDir, 'ard-catalog.ts')
  let catalog = localImports(catalogBody, catalogPath)
  if (contractCopy) catalog = catalog.replace(pathToFileURL(join(community, 'src/generated/ard.ts')).href, pathToFileURL(contractCopy).href)
  writeFileSync(catalogCopy, catalog)
  const ardCopy = join(tempDir, 'ard.ts')
  writeFileSync(ardCopy, localImports(ardBody, ardPath).replace(pathToFileURL(catalogPath).href, pathToFileURL(catalogCopy).href))
  const index = join(tempDir, 'index.ts')
  writeFileSync(index, localImports(worker, workerPath).replace(pathToFileURL(ardPath).href, pathToFileURL(ardCopy).href))
  return index
}
function run(cwd, test, env) {
  const args = cwd === community ? ['--test', '--experimental-transform-types', '--import', './test/loader.mjs', test] : ['--test', test]
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } })
}
function caught(name, result) {
  assert.equal(result.error, undefined)
  assert.notEqual(result.status, 0, `SURVIVED: ${name}`)
  assert.match(result.stdout, /failureType: 'testCodeFailure'/)
  assert.match(result.stdout, /# cancelled 0/)
  console.log(`CAUGHT: ${name}`)
}
try {
  for (const [cwd, test] of [[plugin, 'test/discovery.test.mjs'], [community, 'test/ard.test.mjs']]) {
    const base = run(cwd, test, {})
    assert.equal(base.status, 0, base.stdout + base.stderr)
  }
  const p = temp(plugin)
  const c = temp(community)
  const profile = [
    ['Agent card identity', 'card.identity.agentId !== agentId || card.identity.did !== did', 'false'],
    ['private route', '(a === 192 && b === 168)', 'false'],
    ['credential disclosure', 'url.username || url.password', 'false'],
    ['query page limit', 'Number(value.pageSize) > 100', 'false'],
  ]
  // Identity and credential guards have independent behavioral fixtures below.
  for (const [name, needle, replacement] of profile) {
    assert.ok(contract.includes(needle), `mutation no longer matches: ${name}`)
    const copy = join(p, 'contract.ts'); writeFileSync(copy, contract.replace(needle, replacement))
    if (name === 'Agent card identity') {
      const index = copyWorker(c, { contractCopy: copy })
      caught(name, run(community, 'test/ard.test.mjs', { IFLOW_TEST_ARD_WORKER: index }))
      continue
    }
    const module = join(p, 'runtime.ts')
    writeFileSync(module, runtime.replaceAll('./ard.ts', pathToFileURL(copy).href))
    const env = { IFLOW_TEST_DISCOVERY_RUNTIME: module }
    if (name === 'query page limit') {
      // Parser tests also import the mutated contract through the Intent parser.
      const parserPath = join(plugin, 'src/web/local-intents.ts')
      const parser = join(p, 'parser.ts')
      writeFileSync(parser, readFileSync(parserPath, 'utf8').replace('../generated/ard.ts', pathToFileURL(copy).href))
      env.IFLOW_TEST_INTENT_PARSER = parser
    }
    caught(name, run(plugin, 'test/discovery.test.mjs', env))
  }
  for (const [name, needle, replacement] of [
    ['publication confirmation', 'args.confirmPublic !== true', 'false'],
    ['publication gate', '!context.enabled', 'false'],
    ['publication signature', '!event?.evidence?.signature', 'false'],
    ['registry response', '!isArdSearchResponse(response)', 'false'],
  ]) {
    assert.ok(runtime.includes(needle), `mutation no longer matches: ${name}`)
    const module = join(p, 'runtime.ts'); writeFileSync(module, localImports(runtime.replace(needle, replacement), runtimePath))
    caught(name, run(plugin, 'test/discovery.test.mjs', { IFLOW_TEST_DISCOVERY_RUNTIME: module }))
  }
  const parserPath = join(plugin, 'src/web/local-intents.ts')
  const parserBody = readFileSync(parserPath, 'utf8')
  const parserNeedle = "peerAgentAuthorityDid !== undefined && !peerAgentAuthorityDid.startsWith('did:key:')"
  assert.ok(parserBody.includes(parserNeedle), 'mutation no longer matches: sync peer authority')
  const parserCopy = join(p, 'parser.ts')
  writeFileSync(parserCopy, localImports(parserBody.replace(parserNeedle, 'false'), parserPath))
  caught('sync peer authority parsing', run(plugin, 'test/local-intents.test.mjs', { IFLOW_TEST_INTENT_PARSER: parserCopy }))
  const w = temp(web)
  const messagePath = join(web, 'src/private/messages.ts')
  const messageBody = readFileSync(messagePath, 'utf8')
  const messageNeedle = "(item.peerAgentAuthorityDid === undefined || (typeof item.peerAgentAuthorityDid === 'string' && item.peerAgentAuthorityDid.startsWith('did:key:')))"
  assert.ok(messageBody.includes(messageNeedle), 'mutation no longer matches: view peer authority')
  const messageCopy = join(w, 'messages.ts')
  writeFileSync(messageCopy, localImports(messageBody.replace(messageNeedle, 'true'), messagePath))
  const webTestPath = join(web, 'test/messages.test.mjs')
  const webTestCopy = join(w, 'messages.test.mjs')
  writeFileSync(webTestCopy, localImports(readFileSync(webTestPath, 'utf8'), webTestPath).replace(pathToFileURL(messagePath).href, pathToFileURL(messageCopy).href))
  caught('private View peer authority', spawnSync(process.execPath, ['--test', '--experimental-transform-types', '--import', '../iflowone-community/test/loader.mjs', webTestCopy], { cwd: web, encoding: 'utf8', timeout: 30000 }))
  const replayPath = join(web, '../../packages/iflow-hub-ui/src/journal-replay.ts')
  const replayBody = readFileSync(replayPath, 'utf8')
  for (const [name, needle, replacement] of [
    ['empty public replay page', 'if (!page.hasMore) return events', 'if (!page.hasMore || page.events.length === 0) return events'],
    ['replay cursor progress', '!Number.isSafeInteger(page.lastSeq) || page.lastSeq <= fromSeq', 'false'],
  ]) {
    assert.ok(replayBody.includes(needle), `mutation no longer matches: ${name}`)
    const replayCopy = join(w, 'journal-replay.ts')
    writeFileSync(replayCopy, localImports(replayBody.replace(needle, replacement), replayPath))
    caught(name, spawnSync(process.execPath, ['--test', '--experimental-transform-types', '--import', '../iflowone-community/test/loader.mjs', 'test/journal-replay.test.mjs'], { cwd: web, encoding: 'utf8', timeout: 30000, env: { ...process.env, IFLOW_TEST_JOURNAL_REPLAY: replayCopy } }))
  }
  for (const [name, needle, replacement] of [
    ['Agent signature verification', '!(await verifyDidKeySignature(did, signature, signableBytes(event)))', 'false'],
    ['public visibility', "event.visibility !== 'public'", 'false'],
    ['withdrawal invalidation', 'entries.delete(identifier)\n      if (!validateAgentDiscoveryProfile', '// mutation: retain previous card\n      if (!validateAgentDiscoveryProfile'],
    ['registry identity replacement', "if (entries.get(identifier)?.metadata?.agentDid !== did) entries.delete(identifier)", '// mutation: inherit old identity card'],
    ['query-bound cursor', 'cursor.head !== current.head || cursor.query !== key || cursor.publisher !== publisher', 'false'],
  ]) {
    const body = name === 'query-bound cursor' ? ard : catalogSource
    assert.ok(body.includes(needle), `mutation no longer matches: ${name}`)
    const index = copyWorker(c, name === 'query-bound cursor'
      ? { ardBody: body.replace(needle, replacement) }
      : { catalogBody: body.replace(needle, replacement) })
    caught(name, run(community, 'test/ard.test.mjs', { IFLOW_TEST_ARD_WORKER: index }))
  }
  const domainPath = join(core, 'packages/iflow-domain/src/reducers/network-state.ts')
  const domain = readFileSync(domainPath, 'utf8')
  const needle = 'if (event.payload.did !== undefined && event.payload.did !== agent.did) agent.discovery = null'
  assert.ok(domain.includes(needle), 'mutation no longer matches: domain identity replacement')
  const d = temp(join(core, 'packages/iflow-domain/test'))
  const module = join(d, 'network-state.ts')
  writeFileSync(module, localImports(domain.replace(needle, '// mutation: inherit old identity card'), domainPath))
  const testPath = join(core, 'packages/iflow-domain/test/ard-profile.test.ts')
  const testCopy = join(d, 'ard-profile.test.ts')
  writeFileSync(testCopy, localImports(readFileSync(testPath, 'utf8'), testPath).replace(pathToFileURL(domainPath).href, pathToFileURL(module).href))
  const domainResult = spawnSync(process.execPath, [join(core, 'node_modules/vitest/vitest.mjs'), 'run', testCopy], { cwd: core, encoding: 'utf8', timeout: 30000 })
  assert.equal(domainResult.error, undefined)
  assert.notEqual(domainResult.status, 0, 'SURVIVED: domain identity replacement')
  assert.match(domainResult.stdout + domainResult.stderr, /AssertionError/)
  assert.match(domainResult.stdout + domainResult.stderr, /Tests\s+1 failed/)
  console.log('CAUGHT: domain identity replacement')
} finally {
  for (const [root, dir] of copies) {
    assert.equal(dirname(resolve(dir)), root)
    assert.ok(dir.startsWith(join(root, '.ard-guard-check-')))
    rmSync(dir, { recursive: true, force: true })
  }
}
