import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root, encoding: 'utf8', timeout: 60_000, shell: process.platform === 'win32',
})
assert.ifError(result.error)
assert.equal(result.status, 0, result.stderr)
const [packed] = JSON.parse(result.stdout)
assert.equal(packed.name, manifest.name)
assert.equal(packed.version, manifest.version)
const paths = new Set(packed.files.map(file => file.path))
const expected = new Set(['package.json', ...manifest.files])
for (const path of expected) assert.ok(paths.has(path), `Missing package file: ${path}`)
for (const path of paths) assert.ok(expected.has(path) || path === 'LICENSE', `Unexpected package file: ${path}`)
console.log(`Verified ${packed.name}@${packed.version}: ${paths.size} package files`)
