/**
 * 插件壳的离线测试：不启动豆包、不连 CDP，只验证
 *   1. 配置归一化
 *   2. apply() 能注册 doubao_paint / doubao_status
 *   3. 注册的工具定义符合 DSH 工具注册表的硬性形状
 *      （output.schema 是 object 根、output.render 是函数、parameters 是 object 根）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, resolveConfig, inject, name } from '../lib/index.js'

function fakeCtx() {
  const registered = []
  const ctx = {
    tools: {
      register(def) { registered.push(def); return () => {} },
    },
    workingDirectory: {
      async ensure() { return process.cwd() },
      async set() { return process.cwd() },
    },
  }
  return { ctx, registered }
}

test('包名与 inject 声明', () => {
  assert.equal(name, 'dsh-doubao-painter')
  assert.ok(inject.includes('tools'))
  assert.ok(inject.includes('workingDirectory'))
})

test('resolveConfig 给出稳定默认值', () => {
  const c = resolveConfig(undefined)
  assert.equal(c.enabled, true)
  assert.equal(c.cdpPort, 9225)
  assert.equal(c.newChatPerTask, true)
  assert.equal(c.outSubdir, 'doubao-images')
  assert.equal(c.timeoutMs, 180000)
  assert.match(c.appExe, /Doubao\.exe$/i)

  const c2 = resolveConfig({ enabled: false, cdpPort: 9333, appExe: 'X:\\a.exe', timeoutMs: 1000, newChatPerTask: false, outSubdir: 'pics' })
  assert.equal(c2.enabled, false)
  assert.equal(c2.cdpPort, 9333)
  assert.equal(c2.appExe, 'X:\\a.exe')
  assert.equal(c2.timeoutMs, 1000)
  assert.equal(c2.newChatPerTask, false)
  assert.equal(c2.outSubdir, 'pics')
})

test('非法配置回落到默认值', () => {
  const c = resolveConfig({ cdpPort: 0, timeoutMs: -5, appExe: '   ' })
  assert.equal(c.cdpPort, 9225)
  assert.equal(c.timeoutMs, 180000)
  assert.match(c.appExe, /Doubao\.exe$/i)
})

test('disabled 时不注册任何工具', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { enabled: false })
  assert.equal(registered.length, 0)
})

test('apply 注册两个工具且形状合法', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, {})
  const names = registered.map((d) => d.name)
  assert.deepEqual(names, ['doubao_paint', 'doubao_status'])

  for (const def of registered) {
    assert.equal(typeof def.description, 'string')
    assert.ok(def.description.length > 10)
    assert.equal(def.parameters.type, 'object')
    assert.equal(def.parameters.additionalProperties, false)
    assert.equal(def.output.schema.type, 'object')
    assert.equal(typeof def.output.render, 'function')
    assert.equal(typeof def.execute, 'function')
    // render 返回 DSH 认识的 content blocks
    const blocks = def.output.render({}, { files: ['C:\\a.png'], urls: [], seconds: 1.2 })
    assert.ok(Array.isArray(blocks))
    assert.equal(blocks[0].type, 'text')
    assert.equal(typeof blocks[0].text, 'string')
  }
})

test('doubao_paint 参数必填 prompt', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, {})
  const paint = registered.find((d) => d.name === 'doubao_paint')
  assert.ok(paint.parameters.properties.prompt, '要有 prompt 参数')
  assert.ok(paint.parameters.properties.prompts, '要有批量 prompts 参数')
  assert.equal(paint.parameters.properties.prompt.type, 'string')
  assert.equal(paint.parameters.properties.ref_images.type, 'array')
  assert.equal(paint.parameters.properties.ref_images.items.type, 'string')
})

test('doubao_paint 拒绝空 prompt 与相对路径参考图', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, {})
  const paint = registered.find((d) => d.name === 'doubao_paint')
  const exec = { agent: {}, signal: new AbortController().signal }

  await assert.rejects(() => paint.execute({ prompt: '   ' }, exec), /prompt \/ prompts 至少要给一个/)
  await assert.rejects(
    () => paint.execute({ prompt: 'x', ref_images: ['relative.png'] }, exec),
    /绝对路径/,
  )
  await assert.rejects(
    () => paint.execute({ prompt: 'x', ref_images: ['C:\\definitely-not-here\\nope.png'] }, exec),
    /参考图不存在/,
  )
})

test('doubao_status 返回结构化状态且不抛错', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { cdpPort: 65530, appExe: 'C:\\nope\\not-there.exe' })
  const status = registered.find((d) => d.name === 'doubao_status')
  const r = await status.execute({}, { agent: {}, signal: new AbortController().signal })
  assert.equal(typeof r.cdpAlive, 'boolean')
  assert.equal(r.cdpAlive, false)
  assert.equal(r.appExeExists, false)
  assert.equal(typeof r.hint, 'string')
  assert.ok(r.hint.length > 0)
})
