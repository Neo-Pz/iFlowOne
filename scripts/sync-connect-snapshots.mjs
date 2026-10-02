// Portable Connect sources for consumers of the currently published 0.7.0 packages.
// The source of truth stays in Connect; consumers never hand-maintain this code.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const connect = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const siblings = resolve(connect, '..')
function component(id) {
  const matches = readdirSync(siblings, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(siblings, entry.name)).filter(root => {
    const manifest = join(root, 'iflow.component.json')
    return existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).componentId === id
  })
  if (matches.length !== 1) throw new Error(`Expected one ${id} component, found ${matches.length}`)
  return matches[0]
}
const plugin = component('dsh-plugin')
const community = component('community')
const sources = [
  ['packages/iflow-protocol/src/ard.ts', [join(plugin, 'src/generated/ard.ts'), join(community, 'apps/iflowone-community/src/generated/ard.ts'), join(community, 'apps/iflowone-web/src/generated/ard.ts')]],
  ['packages/iflow-protocol/src/agent-ref.ts', [join(community, 'apps/iflowone-community/src/generated/agent-ref.ts'), join(community, 'apps/iflowone-web/src/generated/agent-ref.ts'), join(plugin, 'src/generated/agent-ref.ts')]],
  ['packages/iflow-protocol/src/a2a.ts', [join(plugin, 'src/generated/a2a.ts')]],
  ...['conversation-service', 'discovery-runtime', 'agent-runtime'].map(name => [`packages/iflow-adapter-sdk/src/${name}.ts`, [join(plugin, `src/generated/${name}.ts`)]]),
]
for (const [relative, targets] of sources) {
  const source = readFileSync(join(connect, relative), 'utf8').replace(/\r\n/g, '\n')
  const hash = createHash('sha256').update(source).digest('hex')
  const portable = source.replaceAll("from 'iflow-protocol'", "from './ard.ts'")
    .replace(/import type \{([^}]*\bIFlowEvidence\b[^}]*)\} from '\.\/ard\.ts'/g, (_line, names) => {
      const ardTypes = names.split(',').map(name => name.trim()).filter(name => name !== 'IFlowEvidence')
      return `import type { ${ardTypes.join(', ')} } from './ard.ts'\nimport type { IFlowEvidence } from 'iflow-protocol'`
    })
  const snapshot = `// GENERATED from iFlow Connect/${relative}; SHA256 ${hash}\n// Regenerate: node ../iflow-connect/scripts/sync-connect-snapshots.mjs. Do not edit.\n${portable}`
  for (const path of targets) {
    if (process.argv.includes('--check')) {
      if (!existsSync(path) || readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== snapshot) throw new Error(`Connect snapshot drift: ${path}`)
    } else {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, snapshot)
    }
  }
  console.log(`Connect snapshot verified: ${relative} (${hash.slice(0, 12)})`)
}
