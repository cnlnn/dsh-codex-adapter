import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const requested = args[0] ?? 'latest'
const output = resolve(args[1] ?? 'compat-result')
if (!/^(latest|next|\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.test(requested)) throw new Error('Expected an npm channel or exact DSH version')
await mkdir(output, { recursive: true })
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
function command(cmd, argv, cwd, env = process.env) {
  const result = spawnSync(cmd, argv, { cwd, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32' && cmd === npm })
  if (result.error || result.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed\n${result.error ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  return result.stdout
}
const metadata = JSON.parse(command(npm, ['view', `@deepseek-ai/dsh@${requested}`, 'version', 'dependencies', '--json'], repo))
const version = metadata.version
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Registry returned an invalid version')
const workspace = await mkdtemp(join(tmpdir(), 'dsh-upstream-'))
let server, browser, page
let serverLog = ''
const result = { version, requested, passed: false }
try {
  const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
  for (const entry of ['index.js', 'lib', 'test', 'cordis.patch.yml']) await cp(join(repo, entry), join(workspace, entry), { recursive: true })
  const candidate = structuredClone(manifest)
  // Candidate declarations are confined to this disposable test installation.
  for (const key of Object.keys(candidate.peerDependencies ?? {})) if (key.startsWith('@deepseek-ai/dsh-')) candidate.peerDependencies[key] = version
  for (const key of Object.keys(candidate.devDependencies ?? {})) {
    if (key.startsWith('@deepseek-ai/dsh-')) candidate.devDependencies[key] = version
    else if (metadata.dependencies[key]) candidate.devDependencies[key] = metadata.dependencies[key]
  }
  candidate.devDependencies['@deepseek-ai/dsh'] = version
  candidate.devDependencies.playwright = '1.64.1'
  await writeFile(join(workspace, 'package.json'), JSON.stringify(candidate, null, 2))
  const home = join(workspace, 'home')
  await mkdir(home)
  const env = { ...process.env, DSH_HOME: home, CODEX_HOME: join(home, 'codex-adapter') }
  await writeFile(join(output, 'install.log'), command(npm, ['install', '--no-audit', '--no-fund'], workspace, env))
  const tests = command(process.execPath, ['--test', '--test-reporter=tap'], workspace, env)
  await writeFile(join(output, 'tests.tap'), tests)
  if (/^ok .*# SKIP/im.test(tests) || !/^# fail 0$/m.test(tests) || !/^# tests [1-9]\d*$/m.test(tests)) throw new Error('Tests must execute with no failures or skips')
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'compat-profile', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', manifest.name] } }, dependencies: { [manifest.name]: `file:${workspace}` } }))
  const scopeDir = join(profile, 'node_modules', manifest.name.split('/')[0])
  await mkdir(scopeDir, { recursive: true })
  const { symlink } = await import('node:fs/promises')
  await symlink(workspace, join(profile, 'node_modules', manifest.name), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(profile, 'cordis.yml'), '[]\n')
  await writeFile(join(profile, 'cordis.patch.yml'), manifest.name.includes('session-manager') ? '- id: session-manager\n  config:\n    autoRecoverInterruptedGoals: false\n' : '[]\n')
  const cliPkg = JSON.parse(await readFile(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
  const cli = resolve(workspace, 'node_modules/@deepseek-ai/dsh', typeof cliPkg.bin === 'string' ? cliPkg.bin : cliPkg.bin.dsh)
  server = spawn(process.execPath, [cli, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { serverLog += chunk.toString() })
  const deadline = Date.now() + 90_000
  let url
  while (Date.now() < deadline) {
    url = serverLog.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)?.[0]
    if (url) break
    if (server.exitCode !== null) throw new Error('Candidate web server exited')
    await new Promise(r => setTimeout(r, 250))
  }
  if (!url) throw new Error('Candidate web server startup timed out')
  if (/skipping profile bundle|disabling profile plugin row/i.test(serverLog)) throw new Error('Candidate skipped a plugin')
  const { chromium } = await import(join(workspace, 'node_modules/playwright/index.mjs'))
  if (!process.env.DSH_TEST_BROWSER) command(process.execPath, [join(workspace, 'node_modules/playwright/cli.js'), 'install', 'chromium'], workspace, env)
  browser = await chromium.launch({ headless: true, ...(process.env.DSH_TEST_BROWSER ? { executablePath: process.env.DSH_TEST_BROWSER } : {}), args: ['--no-sandbox'] })
  page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if ((message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) || /slot entry crashed/.test(message.text())) errors.push(message.text()) })
  page.on('response', response => {
    if (response.status() < 400) return
    const path = new URL(response.url()).pathname
    // An empty Codex home has no subscription quota to fetch.
    if (manifest.name.includes('codex-adapter') && path.endsWith('/api/quota') && response.status() === 502) return
    errors.push(`HTTP ${response.status()} ${path}`)
  })
  await page.goto(url)
  await page.waitForTimeout(1500)
  // Fresh profiles show the preview notice, followed by account onboarding.
  await page.getByRole('button', { name: /^(继续|Continue)$/ }).click({ timeout: 10000 }).catch(async error => {
    if (await page.getByRole('dialog').count()) throw error
  })
  const onboarding = page.getByRole('dialog').filter({ hasText: /登录 DeepSeek|Sign in to DeepSeek/ })
  if (await onboarding.count()) {
    const close = onboarding.getByRole('button', { name: /关闭|Close/ })
    if (await close.count()) await close.click()
    else await page.keyboard.press('Escape')
  }
  const origin = new URL(url).origin
  const { verifyPlugin } = await import('./verify-browser.mjs')
  await verifyPlugin({ page, origin, workspace, home, manifest, command, env })
  if (errors.length) throw new Error(`Browser errors: ${errors.join('\n')}`)
  await page.screenshot({ path: join(output, 'browser.png'), fullPage: true })
  result.passed = true
  result.plugin = { name: manifest.name, version: manifest.version }
  result.checks = ['isolated-unit-integration-tests', 'real-web-profile', 'browser-render', 'plugin-api']
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
    await writeFile(join(output, 'page.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {})
  }
  await writeFile(join(output, 'failure.log'), String(error.stack ?? error).replace(/token=[\w-]+/g, 'token=[redacted]'))
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  if (server && server.exitCode === null) {
    server.kill('SIGTERM')
    await Promise.race([new Promise(r => server.once('exit', r)), new Promise(r => setTimeout(r, 5000))])
    if (server.exitCode === null) server.kill('SIGKILL')
  }
  await writeFile(join(output, 'server.log'), serverLog.replace(/token=[\w-]+/g, 'token=[redacted]'))
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  console.log(JSON.stringify(result))
}
