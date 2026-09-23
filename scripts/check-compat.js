import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const supported = ['0.1.1-rc.2', '0.1.5-rc.3', '0.1.7-rc.1']
const versions = process.argv.length > 2 ? process.argv.slice(2) : supported
for (const version of versions) {
  if (!supported.includes(version)) throw new Error(`Untested DSH profile: ${version}`)
}

function run(command, args, cwd) {
  const npmCli = command === 'npm' ? process.env.npm_execpath : undefined
  const result = spawnSync(npmCli ? process.execPath : command, npmCli ? [npmCli, ...args] : args, {
    cwd, stdio: 'inherit', shell: command === 'npm' && !npmCli && process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

for (const version of versions) {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-codex-matrix-'))
  console.log(`\nDSH ${version} / Codex ${pkg.dependencies['@openai/codex']} / ${workspace}`)
  try {
    for (const path of ['index.js', 'lib', 'test']) cpSync(join(root, path), join(workspace, path), { recursive: true })
    const manifest = structuredClone(pkg)
    for (const name of Object.keys(manifest.devDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) manifest.devDependencies[name] = version
    }
    const profile = supported.indexOf(version)
    manifest.devDependencies['@deepseek-ai/cordis'] = ['4.0.1', '4.0.2', '4.0.4'][profile]
    manifest.devDependencies['@deepseek-ai/schemastery'] = ['3.18.1', '3.18.2', '3.18.4'][profile]
    writeFileSync(join(workspace, 'package.json'), JSON.stringify(manifest, null, 2))
    if (version === supported[0]) {
      cpSync(join(root, 'package-lock.json'), join(workspace, 'package-lock.json'))
      run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], workspace)
    } else {
      // Modern DSH profiles do not auto-install peers. Select one host generation.
      run('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], workspace)
    }
    run(process.execPath, ['--test'], workspace)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}
