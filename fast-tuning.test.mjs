import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject } from './fast-tuning.mjs'

function context(on) {
  return { agentPresets: { composedPreset: agentCtx => agentCtx.preset }, on }
}

function listener() {
  let request
  apply(context((event, callback) => {
    if (event === 'agent/request') request = callback
  }))
  return request
}

const fast = { agent: { ctx: { preset: 'fast' }, session: { header: { agentPreset: 'fast' } } } }

test('显式选择的 off、low、high、max 均不被覆盖', async () => {
  const request = listener()
  for (const reasoningEffort of ['off', 'low', 'high', 'max']) {
    const selection = { provider: 'example', model: 'example', reasoningEffort }
    const result = await request(fast, async () => selection)
    assert.equal(result.reasoningEffort, reasoningEffort)
    assert.equal(result.provider, selection.provider)
    assert.equal(result.maxTokens, undefined)
  }
})

test('快速模式未选择档位时才补 low，其他请求参数保留', async () => {
  assert.deepEqual(await listener()(fast, async () => ({ maxTokens: 123 })), {
    maxTokens: 123, reasoningEffort: 'low',
  })
})

test('其他预设和缺少 agent 的请求不受影响', async () => {
  const request = listener()
  const selection = { model: 'example' }
  for (const payload of [{}, { agent: { ctx: { preset: 'standard' }, session: { header: { agentPreset: 'standard' } } } }]) {
    assert.equal(await request(payload, async () => selection), selection)
  }
})

test('上游请求错误保持原样，避免掩盖失败', async () => {
  const failure = new Error('上游请求失败')
  await assert.rejects(listener()(fast, async () => { throw failure }), error => error === failure)
})

test('第三步追加收尾提醒，新用户回合重置，复杂任务不会被强制拒绝', async () => {
  let preStep
  apply(context((event, callback) => { if (event === 'agent/pre-step') preStep = callback }))
  const agent = fast.agent
  const decision = { kind: 'enter', messages: [] }
  const user = { source: { kind: 'user' } }
  const first = await preStep({ agent, messages: [user] }, async () => decision)
  assert.match(first.messages[0].content[0].text, /最小可运行版本/)
  assert.equal(await preStep({ agent, messages: [] }, async () => decision), decision)
  const third = await preStep({ agent, messages: [] }, async () => decision)
  assert.equal(third.kind, 'enter')
  assert.equal(third.messages[0].source.kind, 'fast-mode-budget')
  assert.match(third.messages[0].content[0].text, /2 个模型步骤/)
  const reset = await preStep({ agent, messages: [user] }, async () => decision)
  assert.match(reset.messages[0].content[0].text, /快速模式执行提醒/)
})

test('默认不加未经通道验证的输出上限，保留用户显式预算', async () => {
  const request = listener()
  for (const maxTokens of [1024, 32768]) {
    const result = await request(fast, async () => ({ maxTokens, reasoningEffort: 'high' }))
    assert.deepEqual(result, { maxTokens, reasoningEffort: 'high' })
  }
  assert.equal((await request(fast, async () => ({}))).maxTokens, undefined)
})

test('可以调整缺省输出预算，非法预算在加载时拒绝', async () => {
  let request
  apply(context((event, callback) => { if (event === 'agent/request') request = callback }), { maxTokens: 8192 })
  assert.equal((await request(fast, async () => ({}))).maxTokens, 8192)
  for (const maxTokens of [0, -1, 1.5, NaN, '8192']) {
    assert.throws(() => apply({ on() {} }, { maxTokens }), /maxTokens/)
  }
})

test('收尾提醒不改写被拒绝的步骤和其他预设', async () => {
  let preStep
  apply(context((event, callback) => { if (event === 'agent/pre-step') preStep = callback }))
  const rejection = { kind: 'reject' }
  assert.equal(await preStep({ agent: fast.agent, messages: [] }, async () => rejection), rejection)
  const decision = { kind: 'enter', messages: [] }
  const agent = { ctx: { preset: 'standard' }, session: { header: { agentPreset: 'standard' } } }
  for (let i = 0; i < 5; i++) {
    assert.equal(await preStep({ agent, messages: [] }, async () => decision), decision)
  }
})

test('长任务的视觉迭代不因步骤多而被取消或收起工具', async () => {
  let preStep
  const agent = {
    session: { header: { agentPreset: 'fast' } },
    ctx: { preset: 'fast', tools: { restrict() { assert.fail('不应限制质量验证所需工具') } } },
  }
  apply(context((event, callback) => { if (event === 'agent/pre-step') preStep = callback }))
  const next = async () => ({ kind: 'enter', messages: [] })
  for (let step = 1; step <= 50; step++) {
    assert.equal((await preStep({ agent, messages: [] }, next)).kind, 'enter')
  }
})

test('预设切换使用实际挂载状态，切出后停止干预，重新进入重置提醒', async () => {
  assert.deepEqual(inject, ['agentPresets'])
  const handlers = new Map()
  apply(context((event, callback) => handlers.set(event, callback)), { maxTokens: 8192 })
  // 创建信息不可变，后续选择由当前挂载的预设表达。
  const agent = {
    ctx: { preset: 'standard' },
    session: { header: Object.freeze({ agentPreset: 'standard' }) },
  }
  const decision = { kind: 'enter', messages: [] }
  const step = () => handlers.get('agent/pre-step')({ agent, messages: [] }, async () => decision)
  const selection = { model: 'example' }
  const request = () => handlers.get('agent/request')({ agent }, async () => selection)
  assert.equal(await step(), decision)
  assert.equal(await request(), selection)

  agent.ctx.preset = 'fast'
  assert.match((await step()).messages[0].content[0].text, /快速模式执行提醒/)
  assert.deepEqual(await request(), { model: 'example', reasoningEffort: 'low', maxTokens: 8192 })
  assert.equal(await step(), decision)
  assert.match((await step()).messages[0].content[0].text, /2 个模型步骤/)

  agent.ctx.preset = 'standard'
  assert.equal(await step(), decision)
  assert.equal(await request(), selection)
  agent.ctx.preset = 'fast'
  assert.match((await step()).messages[0].content[0].text, /快速模式执行提醒/)
  assert.equal(agent.session.header.agentPreset, 'standard')
})

test('创建时为 fast 但当前已切出或未绑定时，不按旧 header 注入', async () => {
  const handlers = new Map()
  apply(context((event, callback) => handlers.set(event, callback)))
  for (const preset of ['standard', undefined]) {
    const agent = { ctx: { preset }, session: { header: { agentPreset: 'fast' } } }
    const decision = { kind: 'enter', messages: [] }
    assert.equal(await handlers.get('agent/pre-step')({ agent, messages: [] }, async () => decision), decision)
    const selection = { model: 'example' }
    assert.equal(await handlers.get('agent/request')({ agent }, async () => selection), selection)
  }
})
