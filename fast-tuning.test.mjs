import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from './fast-tuning.mjs'

function listener() {
  let request
  apply({ on(event, callback) {
    if (event === 'agent/request') request = callback
  } })
  return request
}

const fast = { agent: { session: { header: { agentPreset: 'fast' } } } }

test('显式选择的 off、low、high、max 均不被覆盖', async () => {
  const request = listener()
  for (const reasoningEffort of ['off', 'low', 'high', 'max']) {
    const selection = { provider: 'example', model: 'example', reasoningEffort }
    assert.equal(await request(fast, async () => selection), selection)
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
  for (const payload of [{}, { agent: { session: { header: { agentPreset: 'standard' } } } }]) {
    assert.equal(await request(payload, async () => selection), selection)
  }
})

test('上游请求错误保持原样，避免掩盖失败', async () => {
  const failure = new Error('上游请求失败')
  await assert.rejects(listener()(fast, async () => { throw failure }), error => error === failure)
})

test('第三步追加收尾提醒，新用户回合重置，复杂任务不会被强制拒绝', async () => {
  let preStep
  apply({ on(event, callback) { if (event === 'agent/pre-step') preStep = callback } })
  const agent = fast.agent
  const decision = { kind: 'enter', messages: [] }
  const user = { source: { kind: 'user' } }
  assert.equal(await preStep({ agent, messages: [user] }, async () => decision), decision)
  assert.equal(await preStep({ agent, messages: [] }, async () => decision), decision)
  const third = await preStep({ agent, messages: [] }, async () => decision)
  assert.equal(third.kind, 'enter')
  assert.equal(third.messages[0].source.kind, 'fast-mode-budget')
  assert.match(third.messages[0].content[0].text, /2 个模型步骤/)
  assert.equal(await preStep({ agent, messages: [user] }, async () => decision), decision)
})

test('收尾提醒不改写被拒绝的步骤和其他预设', async () => {
  let preStep
  apply({ on(event, callback) { if (event === 'agent/pre-step') preStep = callback } })
  const rejection = { kind: 'reject' }
  assert.equal(await preStep({ agent: fast.agent, messages: [] }, async () => rejection), rejection)
  const decision = { kind: 'enter', messages: [] }
  const agent = { session: { header: { agentPreset: 'standard' } } }
  for (let i = 0; i < 5; i++) {
    assert.equal(await preStep({ agent, messages: [] }, async () => decision), decision)
  }
})
