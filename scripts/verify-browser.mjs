import assert from 'node:assert/strict'

export async function verifyPlugin({ page, origin, manifest }) {
  await page.getByRole('button', { name: /^(插件|Plugins)$/ }).click()
  await page.getByText(manifest.name, { exact: true }).click()
  await page.getByText('ChatGPT 账号', { exact: true }).waitFor()
  await page.getByRole('button', { name: '获取可用模型', exact: true }).waitFor()
  const response = await page.request.get(`${origin}/plugins/${manifest.name}/api/auth/status`)
  assert.equal(response.status(), 200)
  const status = await response.json()
  assert.equal(status.ok, true)
  assert.equal(status.value.signedIn, false, 'fresh test home must contain no login')
  // Exercise config persistence with no account or external model request.
  const toggle = page.getByRole('checkbox', { name: '允许 Codex 访问网络' })
  const initial = await toggle.isChecked()
  await toggle.setChecked(!initial)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '保存' && b.disabled))
  await page.reload()
  await page.getByRole('button', { name: /^(插件|Plugins)$/ }).click()
  await page.getByText(manifest.name, { exact: true }).click()
  await page.getByRole('checkbox', { name: '允许 Codex 访问网络' }).waitFor()
  await page.waitForFunction(expected => [...document.querySelectorAll('label')].some(label => label.textContent.includes('允许 Codex 访问网络') && label.querySelector('input')?.checked === expected), !initial)
  assert.equal(await page.getByRole('checkbox', { name: '允许 Codex 访问网络' }).isChecked(), !initial)
}
