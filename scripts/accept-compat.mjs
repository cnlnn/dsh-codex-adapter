import { readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const evidence = resolve(process.argv[2] ?? 'compat-result')
const results = []
async function visit(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await visit(child)
    else if (entry.name === 'result.json') results.push(JSON.parse(await readFile(child, 'utf8')))
  }
}
await visit(evidence)
if (!results.length || results.some(r => r.passed !== true)) throw new Error('All candidate results must pass')
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
for (const result of results) {
  if (result.plugin?.name !== manifest.name || result.plugin?.version !== manifest.version) throw new Error('Evidence refers to a different plugin')
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(result.version)) throw new Error('Invalid version')
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    if (!range.split(' || ').includes(result.version)) manifest.peerDependencies[name] = `${range} || ${result.version}`
  }
}
lock.packages[''].peerDependencies = { ...manifest.peerDependencies }
await writeFile('package.json', JSON.stringify(manifest, null, 2) + '\n')
await writeFile('package-lock.json', JSON.stringify(lock, null, 2) + '\n')
console.log('Accepted exact versions:', [...new Set(results.map(r => r.version))].join(', '))
