import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { Context } from '@deepseek-ai/cordis'
import * as settings from '@deepseek-ai/dsh-settings'
import { CODEX_SETTINGS_NAMESPACE, Config, CodexSubscriptionAdapter, installCodexSettings, appServerThreadParams, apply } from '../index.js'
import { CodexAppServerRpc, resolveCodexRuntimePaths } from '../lib/app-server.js'

async function loadClient(options = {}) {
  let client
  runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    document: { querySelector: () => ({}) },
    fetch: options.fetch,
    window: { __ModuleLoader__: { load({ factory }) {
      client = factory(name => name === 'react' ? React : options.modernIcons ? {
        IconChevronDownOutlineRegular: () => null,
        IconRefreshOutlineRegular: () => null,
      } : {
        IconChevronDownOutline14: () => null,
        IconRefreshOutline14: () => null,
      })
    } } },
  })
  return client
}

test('settings client preserves the legacy API without requiring Remote', async () => {
  const { settingsApi } = await loadClient()
  const legacy = { settings: {}, llm: {} }
  assert.equal(settingsApi({ get(name) {
    assert.equal(name, 'connection')
    return { api: legacy }
  } }), legacy)
})

test('React settings pages load and save using legacy, Remote and Config Forms namespaces', async () => {
  for (const mode of ['legacy', 'remote', 'forms', 'forms-modern-icons']) {
    const ns = mode.startsWith('forms') ? 'codex-subscription-provider' : CODEX_SETTINGS_NAMESPACE
    let revision = 3
    let value = { models: [], allowNetworkAccess: false }
    const mutations = []
    const remote = {
      settings: {
        describe: async () => ({ ok: true, value: { writable: true, namespaces: [{ ns, value, revision }] } }),
        mutate: async (namespace, ops, expectedRevision) => {
          mutations.push({ namespace, expectedRevision })
          assert.equal(namespace, ns)
          assert.equal(expectedRevision, revision)
          for (const op of ops) value = { ...value, [op.path[0]]: op.op === 'unset' ? [] : op.value }
          return { ok: true, value: { ns, value, revision: ++revision } }
        },
      },
      llm: { discoverModels: async () => ({ ok: true, value: [] }) },
    }
    const api = {
      settings: {
        describe: async () => ({ result: await remote.settings.describe() }),
        mutate: async ({ ns, ops, expectedRevision }) => ({ result: await remote.settings.mutate(ns, ops, expectedRevision) }),
      },
    }
    const callbacks = new Map()
    const ctx = {
      get: name => name === 'connection' ? (mode === 'legacy' ? { api } : {}) : remote,
      inject: (_names, callback) => { callback(ctx) },
      slots: {
        inject: (_name, callback) => { callback() },
        register: (options, render) => { callbacks.set(options.name, render) },
      },
    }
    const client = await loadClient({ modernIcons: mode === 'forms-modern-icons', fetch: async () => ({ ok: true, json: async () => ({ ok: true, value: { signedIn: false, buckets: [] } }) }) })
    client.apply(ctx)
    const render = callbacks.get(mode.startsWith('forms') ? 'plugins.bundle.config' : 'settings.plugin.item')
    let tree
    try {
      await act(async () => { tree = create(React.createElement(() => render({ view: 'page' }))) })
      const checkbox = tree.root.findByProps({ type: 'checkbox' })
      assert.equal(checkbox.props.disabled, false)
      await act(async () => checkbox.props.onChange({ target: { checked: true } }))
      await act(async () => tree.root.findByProps({ className: 'dca-save' }).props.onClick())
      assert.equal(value.allowNetworkAccess, true)
      assert.equal(mutations.length, 1)
      assert.equal(tree.root.findByProps({ className: 'dca-save' }).props.disabled, true)
    } finally {
      await act(async () => tree?.unmount())
    }
  }
})

test('settings client bridges Remote arguments, results, failures and revisions', async () => {
  const { settingsApi } = await loadClient()
  const view = { namespaces: [], writable: true }
  const failure = { ok: false, error: { message: 'revision conflict' } }
  const calls = []
  const remote = {
    settings: {
      describe: async () => ({ ok: true, value: view }),
      mutate: async (...args) => { calls.push(args); return failure },
    },
    llm: { discoverModels: async (...args) => {
      calls.push(args)
      return { ok: true, value: [{ id: 'model' }] }
    } },
  }
  const ctx = { get: name => name === 'connection' ? {} : remote }
  const api = settingsApi(ctx)
  assert.equal(settingsApi(ctx), api)
  assert.equal((await api.settings.describe()).result.value, view)
  const ops = [{ op: 'unset', path: ['models'] }]
  assert.equal((await api.settings.mutate({ ns: CODEX_SETTINGS_NAMESPACE, ops, expectedRevision: 7 })).result, failure)
  assert.deepEqual(calls.shift(), [CODEX_SETTINGS_NAMESPACE, ops, 7])
  const catalog = await api.llm.discoverModels({ settingsNs: CODEX_SETTINGS_NAMESPACE, provider: 'codex' })
  assert.equal(catalog.result.value.models[0].id, 'model')
  assert.equal(calls[0][0], CODEX_SETTINGS_NAMESPACE)
  assert.equal(calls[0][1].provider, 'codex')
  assert.equal('settingsNs' in calls[0][1], false)
  remote.llm.discoverModels = async () => failure
  assert.equal((await api.llm.discoverModels({ settingsNs: CODEX_SETTINGS_NAMESPACE })).result, failure)
  remote.settings.describe = async () => { throw new Error('disconnected') }
  await assert.rejects(api.settings.describe(), /disconnected/)
})

test('client registers immediately on legacy DSH and waits for modern Remote services', async () => {
  const client = await loadClient()
  for (const modern of [false, true]) {
    let registrations = 0
    let injected
    const ctx = {
      get: () => modern ? {} : { api: {} },
      slots: {
        inject(name, callback) {
          if (name === 'settings.plugin.item') callback()
          else assert.equal(name, 'plugins.bundle.config')
        },
        register(options) { assert.equal(options.key, CODEX_SETTINGS_NAMESPACE); registrations++ },
      },
      inject(names, callback) { injected = { names, callback } },
    }
    client.apply(ctx)
    assert.equal(registrations, modern ? 0 : 1)
    if (modern) {
      assert.equal(Array.from(injected.names).join(','), 'remote,remote.settings,remote.llm')
      injected.callback(ctx)
      assert.equal(registrations, 1)
    }
  }
})

test('native settings registration, updates and detach preserve the config source', async () => {
  if (settings.SettingsForms) return testConfigForms()
  const { SettingsProvider } = settings
  class MemorySettings extends SettingsProvider {
    writable = true
    async load() { return {} }
    async persist() {}
  }
  const ctx = new Context()
  const entry = { models: [], allowNetworkAccess: false }
  let source = () => entry
  let changes = 0
  try {
    const provider = ctx.plugin(MemorySettings)
    await provider.await()
    const consumer = ctx.plugin(owner => {
      installCodexSettings(owner, entry, {
        setSource: next => { source = next },
        onChange: () => { changes++ },
      })
    })
    await consumer.await()
    assert.equal(ctx.settings.describe().some(view => view.ns === CODEX_SETTINGS_NAMESPACE), true)
    assert.equal(source().allowNetworkAccess, false)
    await ctx.settings.update(CODEX_SETTINGS_NAMESPACE, { allowNetworkAccess: true })
    assert.equal(source().allowNetworkAccess, true)
    assert.ok(changes >= 2)
    await provider.dispose()
    assert.equal(source(), entry)
  } finally {
    await ctx.fiber.dispose()
  }
})

async function testConfigForms() {
  const { updateVolatile } = await import('@deepseek-ai/cosmokit')
  const home = await mkdtemp(join(tmpdir(), 'dsh-codex-forms-'))
  const ctx = new Context()
  const entry = { id: 'codex-subscription-provider', options: { id: 'codex-subscription-provider', config: {} } }
  const base = { models: [], allowNetworkAccess: false }
  let source
  let adapter
  let settingsFiber
  try {
    ctx.provide('profileContext', { home })
    ctx.provide('loader', { await: async () => {} })
    ctx.provide('configEditor', {
      configuration: () => [{ entry, inherited: base, override: entry.options.config }],
      entries: () => [entry],
      async edit(row, change) {
        const raw = change({ ...base, ...row.options.config }, base)
        const next = Config(raw)
        for (const key of Object.keys(next)) updateVolatile(row.fiber.config[key], next[key])
        row.options.config = raw
      },
    })
    const provider = ctx.plugin(settings.SettingsForms)
    await provider.await()
    entry.fiber = ctx.plugin({ Config, apply(owner, config) {
      source = config
      adapter = new CodexSubscriptionAdapter(() => config, () => ({}), async () => [])
      settingsFiber = installCodexSettings(owner, config, { setSource() { throw new Error('Forms must not replace live config references') }, onChange() {} })
    } }, base).ctx.fiber
    await entry.fiber.await()
    await settingsFiber.await()
    const view = ctx.settings.describe().find(row => row.ns === entry.id)
    assert.equal(view.autoGenerate, false)
    assert.equal(view.value.allowNetworkAccess, false)
    await ctx.settings.update(entry.id, { allowNetworkAccess: true, models: [{ id: 'custom-model' }] }, view.revision)
    assert.equal(source.allowNetworkAccess.get(), true)
    assert.equal(adapter.options().allowNetworkAccess, true)
    assert.equal(adapter.options().models[0].id, 'custom-model')
    await assert.rejects(ctx.settings.update(entry.id, { allowNetworkAccess: false }, view.revision), /changed since/)
    await provider.dispose()
    assert.equal(adapter.options().allowNetworkAccess, true)
    const replacement = ctx.plugin(settings.SettingsForms)
    await replacement.await()
    await settingsFiber.await()
    assert.equal(ctx.settings.describe()[0].autoGenerate, false)
    await entry.fiber.dispose()
    assert.equal(ctx.settings.describe().length, 0)
  } finally {
    await adapter?.close()
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
}

test('package and app-server client advertise the same version', async () => {
  const { CODEX_ADAPTER_VERSION } = await import('../lib/app-server.js')
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(CODEX_ADAPTER_VERSION, pkg.version)
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-settings'], undefined)
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-settings'])
})

test('model discovery forwards legacy and modern cancellation signals', async (t) => {
  const effects = []
  let discover
  t.mock.method(CodexSubscriptionAdapter.prototype, 'discoverModels', async signal => signal)
  apply({
    webServer: { register: () => () => {} },
    effect: execute => { effects.push(execute()) },
    inject() {},
    llm: {
      registerAdapter() {},
      registerModelDiscovery(_namespace, callback) { discover = callback },
    },
  }, {})
  try {
    const signal = new AbortController().signal
    assert.equal(await discover({ signal }), signal)
    assert.equal(await discover({ provider: 'codex' }, signal), signal)
  } finally {
    for (const dispose of effects.reverse()) await dispose?.()
  }
})

test('official Codex supports account, catalog and ephemeral thread RPC in a fresh home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-protocol-'))
  const paths = resolveCodexRuntimePaths({ env: { DSH_HOME: root } })
  const rpc = new CodexAppServerRpc({ runtimePaths: paths })
  try {
    const account = await rpc.request('account/read', {})
    assert.equal(account.account, null)
    const catalog = await rpc.request('model/list', {})
    assert.ok(Array.isArray(catalog.data))
    const result = await rpc.request('thread/start', appServerThreadParams({ cwd: paths.workspace, ephemeral: true }))
    assert.equal(typeof result.thread.id, 'string')
    assert.ok(result.thread.id.length > 0)
  } finally {
    await rpc.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
