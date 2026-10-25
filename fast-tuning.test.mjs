import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject } from './fast-tuning.mjs'

function harness(config = {}) {
  const events = new Map()
  let guard
  const asked = []
  let answer
  apply({
    agentPresets: { composedPreset: agentCtx => agentCtx.preset },
    tools: { guard(callback) { guard = callback } },
    on(event, callback) { events.set(event, callback) },
    get(name) {
      if (name !== 'userQuestions' || config.userQuestions === false) return
      return { async ask(request) { asked.push(request); return answer } }
    },
  }, config)
  const agent = (preset = 'fast', header = preset) => ({
    ctx: { preset },
    session: { header: Object.freeze({ agentPreset: header }), records: [], log: [], append(...args) { this.records.push(args) } },
  })
  const user = text => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const decision = { kind: 'enter', messages: [] }
  return {
    events, agent, user, decision, asked,
    reply(value) { answer = value },
    step: (subject, messages = [], step = 1) => events.get('agent/pre-step')({ agent: subject, messages, turn: 1, step, signal: new AbortController().signal }, async () => decision),
    call: (subject, name = 'inspect', args = {}) => guard({ agent: subject, name, arguments: args }),
    request: (subject, selection) => events.get('agent/request')({ agent: subject }, async () => selection),
    assemble: (subject, assembly) => events.get('system-prompt/assemble')(assembly, { scope: subject }, async () => assembly),
  }
}
const notice = result => result.messages.at(-1).content[0].text

test('显式档位与输出预算保留，默认只补 low', async () => {
  const h = harness(), agent = h.agent()
  for (const reasoningEffort of ['off', 'low', 'high', 'max']) {
    for (const maxTokens of [1024, 32768]) {
      const input = { provider: 'example', model: 'example', reasoningEffort, maxTokens }
      assert.deepEqual(await h.request(agent, input), input)
    }
  }
  assert.deepEqual(await h.request(agent, { model: 'example' }), { model: 'example', reasoningEffort: 'low' })
})

test('可选 maxTokens 只补缺省值，配置必须为正整数', async () => {
  const h = harness({ maxTokens: 8192 }), agent = h.agent()
  assert.equal((await h.request(agent, {})).maxTokens, 8192)
  assert.equal((await h.request(agent, { maxTokens: 1024 })).maxTokens, 1024)
  for (const key of ['maxTokens', 'maxToolRounds', 'maxToolCalls', 'toolTimeoutMs']) {
    for (const value of [0, -1, 1.5, NaN, '10']) assert.throws(() => harness({ [key]: value }), RangeError)
  }
  assert.throws(() => harness({ fullPreset: 'fast' }), RangeError)
})

test('其他预设和缺少 agent 不受影响，上游错误保持原样', async () => {
  const h = harness(), input = { model: 'example' }
  for (const agent of [undefined, h.agent('standard')]) assert.equal(await h.request(agent, input), input)
  const failure = new Error('上游失败')
  await assert.rejects(h.events.get('agent/request')({ agent: h.agent() }, async () => { throw failure }), error => error === failure)
})

test('首步提醒先交付，普通后续步骤不再重复核查清单', async () => {
  const h = harness(), agent = h.agent()
  assert.match(notice(await h.step(agent, [h.user('评估当前结果')])) , /默认先返回已确认结论/)
  assert.equal(await h.step(agent), h.decision)
  assert.equal(await h.step(agent), h.decision)
})

test('拒绝的步骤不消耗预算，也不注入消息', async () => {
  const h = harness(), agent = h.agent(), rejection = { kind: 'reject' }
  assert.equal(await h.events.get('agent/pre-step')({ agent, messages: [] }, async () => rejection), rejection)
  assert.match(notice(await h.step(agent)), /当前为快速模式/)
})

test('默认十个工具批次后保留一次无工具回答，同批多个调用只占一轮', async () => {
  const h = harness(), agent = h.agent(), assembly = { tools: [{ name: 'inspect' }], sections: [] }
  for (let round = 1; round <= 10; round++) {
    await h.step(agent)
    assert.equal(h.call(agent), undefined)
    assert.equal(h.call(agent), undefined)
  }
  assert.deepEqual((await h.assemble(agent, assembly)).tools, [])
  assert.equal(assembly.tools.length, 1)
  const answer = await h.step(agent)
  assert.equal(answer.kind, 'enter')
  assert.match(notice(answer), /现在仅回答/)
  assert.match(h.call(agent), /预算已用尽/)
})

test('调用总数独立于轮数限制，同批并发不能突破上限', async () => {
  const h = harness({ maxToolCalls: 3 }), agent = h.agent()
  await h.step(agent)
  const results = await Promise.all(Array.from({ length: 12 }, async () => h.call(agent)))
  assert.equal(results.filter(value => value === undefined).length, 3)
  assert.equal(results.filter(value => typeof value === 'string').length, 9)
  assert.match(notice(await h.step(agent)), /本轮取证已结束/)
})

test('请求不存在的工具同样消耗批次，不能无限重试', async () => {
  const h = harness({ maxToolRounds: 1 }), agent = h.agent()
  await h.step(agent)
  h.events.get('session/event')(agent.session, { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'nonexistent' }] } } })
  const assembly = { tools: [{ name: 'inspect' }] }
  assert.deepEqual((await h.assemble(agent, assembly)).tools, [])
  assert.match(notice(await h.step(agent)), /现在仅回答/)
})

test('失败尝试也计入预算，通知不能重置预算', async () => {
  const h = harness({ maxToolCalls: 1 }), agent = h.agent()
  await h.step(agent)
  assert.equal(h.call(agent), undefined)
  h.events.get('agent/inbox/inserted')({ agent, message: { source: { kind: 'tool-jobs' } } })
  assert.match(h.call(agent), /预算已用尽/)
})

test('新用户入队立即恢复工具并开始新预算，会话之间隔离', async () => {
  const h = harness({ maxToolCalls: 1 }), a = h.agent(), b = h.agent(), assembly = { tools: [{ name: 'inspect' }] }
  await h.step(a, [h.user('任务甲')]); h.call(a)
  assert.deepEqual((await h.assemble(a, assembly)).tools, [])
  assert.equal(await h.assemble(b, assembly), assembly)
  h.events.get('agent/inbox/inserted')({ agent: a, message: h.user('继续任务甲') })
  assert.equal(await h.assemble(a, assembly), assembly)
  assert.match(notice(await h.step(a, [h.user('继续任务甲')])), /继续任务甲/)
  assert.equal(h.call(a), undefined)
})

test('预设切换使用当前挂载状态，不受创建 header 影响', async () => {
  assert.deepEqual(inject, ['agentPresets', 'tools'])
  const h = harness(), agent = h.agent('standard', 'standard')
  assert.equal(await h.step(agent), h.decision)
  agent.ctx.preset = 'fast'
  assert.match(notice(await h.step(agent)), /当前为快速模式/)
  agent.ctx.preset = 'standard'
  assert.equal(await h.step(agent), h.decision)
  assert.equal(await h.request(agent, h.decision), h.decision)
  agent.ctx.preset = 'fast'
  assert.match(notice(await h.step(agent)), /当前为快速模式/)
  assert.equal(agent.session.header.agentPreset, 'standard')
})

test('完整执行模式不使用快速预算或超时，仍保留用户显式选择', async () => {
  const h = harness({ maxToolRounds: 1, maxToolCalls: 1, toolTimeoutMs: 1 }), agent = h.agent('fast-full')
  assert.match(notice(await h.step(agent)), /完整执行模式/)
  for (let i = 0; i < 30; i++) { assert.equal(h.call(agent), undefined); assert.equal((await h.step(agent)).kind, 'enter') }
  const assembly = { tools: [{ name: 'inspect' }] }
  assert.equal(await h.assemble(agent, assembly), assembly)
  assert.deepEqual(await h.request(agent, { reasoningEffort: 'high' }), { reasoningEffort: 'high' })
  const exec = { agent, signal: new AbortController().signal }
  const original = exec.signal
  await h.events.get('tools/execute')(exec, async () => { await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(exec.signal, original) })
})

test('工具超时发出独立取消，恢复原信号并进入回答阶段', async () => {
  const h = harness({ toolTimeoutMs: 5 }), agent = h.agent()
  await h.step(agent); h.call(agent)
  const controller = new AbortController(), exec = { agent, signal: controller.signal }, original = exec.signal
  await h.events.get('tools/execute')(exec, async () => {
    await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
    assert.equal(exec.signal.aborted, true)
  })
  assert.equal(exec.signal, original)
  assert.equal(controller.signal.aborted, false)
  assert.match(notice(await h.step(agent)), /现在仅回答/)
})

test('工具失败恢复信号，用户取消保持可传播', async () => {
  const h = harness(), agent = h.agent(); await h.step(agent)
  const controller = new AbortController(), exec = { agent, signal: controller.signal }, original = exec.signal
  const failure = new Error('执行失败')
  await assert.rejects(h.events.get('tools/execute')(exec, async () => { controller.abort(); assert.equal(exec.signal.aborted, true); throw failure }), error => error === failure)
  assert.equal(exec.signal, original)
})

test('快速模式允许显式后台启动，仍计入普通调用预算', async () => {
  const h = harness({ maxToolCalls: 1 })
  for (const name of ['bash', 'pwsh']) {
    const agent = h.agent()
    await h.step(agent)
    assert.equal(h.call(agent, name, { run_in_background: true }), undefined)
    assert.match(h.call(agent), /预算已用尽/)
  }
  assert.equal(h.call(h.agent('fast-full'), 'bash', { run_in_background: true }), undefined)
})

test('异常模型在最终回答阶段仍请求工具时不会无限循环', async () => {
  const h = harness({ maxToolRounds: 1 }), agent = h.agent()
  await h.step(agent); h.call(agent)
  await h.step(agent)
  assert.match(h.call(agent), /预算已用尽/)
  assert.deepEqual(await h.step(agent, [], 3), { kind: 'reject' })
  assert.match(agent.session.records[0][1].message.content[0].text, /模型未能完成最终回答/)
})

test('请求摘录有界且只包含用户文本，新请求替换旧目标', async () => {
  const h = harness({ maxToolCalls: 1 }), agent = h.agent()
  const first = { source: { kind: 'user' }, content: [{ type: 'image', data: '不注入' }, { type: 'text', text: '甲'.repeat(600) + '超界' }] }
  const result = notice(await h.step(agent, [first]))
  assert.ok(result.endsWith('甲'.repeat(600)))
  assert.doesNotMatch(result, /不注入|超界/)
  h.call(agent)
  assert.match(notice(await h.step(agent)), /甲{600}/)
  const reset = notice(await h.step(agent, [h.user('新目标')]))
  assert.match(reset, /新目标/)
  assert.doesNotMatch(reset, /甲{600}/)
})

test('idle 与销毁时释放预算状态', async () => {
  const h = harness({ maxToolCalls: 1 }), agent = h.agent(), assembly = { tools: [{ name: 'inspect' }] }
  for (const event of ['agent/status', 'agent/disposed']) {
    await h.step(agent); h.call(agent)
    h.events.get(event)({ agent, status: 'idle' })
    assert.equal(await h.assemble(agent, assembly), assembly)
  }
})

test('明确授权在快速模式自动解除轮数与次数预算，不需要换预设', async () => {
  const h = harness({ maxToolRounds: 1, maxToolCalls: 1 }), agent = h.agent()
  assert.match(notice(await h.step(agent, [h.user('请深入排查并修复')])), /用户已明确授权/)
  for (let i = 0; i < 25; i++) {
    assert.equal(h.call(agent), undefined)
    assert.equal((await h.step(agent)).kind, 'enter')
  }
  const assembly = { tools: [{ name: 'inspect' }] }
  assert.equal(await h.assemble(agent, assembly), assembly)
})

test('预算结束后用户确认自动解除，工具通知和单纯问题不能解除', async () => {
  const h = harness({ maxToolCalls: 1 }), agent = h.agent(), assembly = { tools: [{ name: 'inspect' }] }
  await h.step(agent, [h.user('分析当前结果')]); h.call(agent)
  await h.step(agent)
  const reply = h.user('好')
  h.events.get('agent/inbox/inserted')({ agent, message: reply })
  assert.equal(await h.assemble(agent, assembly), assembly)
  assert.match(notice(await h.step(agent, [reply])), /用户已明确授权/)
  for (let i = 0; i < 5; i++) assert.equal(h.call(agent), undefined)
  await h.step(agent, [h.user('另外查看新的对象')])
  assert.equal(h.call(agent), undefined)
  assert.match(h.call(agent), /预算已用尽/)
})

test('直接授权在 idle 后的同任务续问继承，恢复会话可从真实记录重建', async () => {
  const h = harness({ maxToolCalls: 1 }), agent = h.agent()
  await h.step(agent, [h.user('开始实施')])
  h.events.get('agent/status')({ agent, status: 'idle' })
  await h.step(agent, [h.user('进度如何？')])
  assert.equal(h.call(agent), undefined)
  assert.equal(h.call(agent), undefined)
  const restored = h.agent()
  restored.session.log = [{ type: 'user/message', data: h.user('开始实施') }]
  await h.step(restored)
  assert.equal(h.call(restored), undefined)
  assert.equal(h.call(restored), undefined)
})

test('授权不解除单次执行超时，超时后不强制截断已授权工作', async () => {
  const h = harness({ maxToolCalls: 1, toolTimeoutMs: 5 }), agent = h.agent()
  await h.step(agent, [h.user('直接修复')]); h.call(agent)
  const exec = { agent, signal: new AbortController().signal }
  await h.events.get('tools/execute')(exec, async () => new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true })))
  assert.equal(await h.step(agent), h.decision)
  assert.equal(h.call(agent), undefined)
})

test('预算耗尽时弹出选择框，选“继续深入”保留工具并解除本次预算', async () => {
  const h = harness({ maxToolCalls: 1 }), agent = h.agent(), assembly = { tools: [{ name: 'inspect' }] }
  h.reply({ answers: [{ id: 'fast-mode-authorization', selected: ['继续深入'] }] })
  await h.step(agent, [h.user('分析当前结果')]); h.call(agent)
  const resumed = await h.assemble(agent, assembly)
  assert.equal(h.asked.length, 1)
  assert.equal(h.asked[0].questions[0].options.length, 2)
  assert.ok(h.asked[0].agent === agent)
  assert.deepEqual(resumed.tools, assembly.tools, '授权后本步仍保留工具')
  assert.match(notice(await h.step(agent)), /用户已通过选择框授权/)
  for (let i = 0; i < 25; i++) { assert.equal(h.call(agent), undefined); assert.equal((await h.step(agent)).kind, 'enter') }
  assert.equal((await h.assemble(agent, assembly)).tools.length, 1)
  assert.equal(h.asked.length, 1, '每个预算周期只问一次')
  assert.equal(agent.session.records.filter(([, data]) => data.source?.form === 'authorization-choice').length, 1)
})

test('选择“就此交付”停止工具并进入强制回答，选择结果可重放', async () => {
  const h = harness({ maxToolCalls: 1 }), agent = h.agent()
  h.reply({ answers: [{ id: 'fast-mode-authorization', selected: ['就此交付'] }] })
  await h.step(agent); h.call(agent)
  assert.match(notice(await h.step(agent)), /现在仅回答/)
  assert.match(h.call(agent), /预算已用尽/)
  // 交付选择不属于授权，恢复会话后同任务仍受预算限制。
  const restored = h.agent()
  restored.session.log = agent.session.records.map(([, data]) => ({ type: 'user/message', data }))
  await h.step(restored, [h.user('新任务')])
  assert.equal(h.call(restored), undefined)
  assert.match(h.call(restored), /预算已用尽/)
})

test('自由输入作为兜底：授权语义解除预算，无关文字按交付处理', async () => {
  const assembly = { tools: [{ name: 'inspect' }] }
  const grant = harness({ maxToolCalls: 1 }), a = grant.agent()
  grant.reply({ answers: [{ id: 'fast-mode-authorization', selected: [], custom: '继续深入排查，把根因找出来' }] })
  await grant.step(a); grant.call(a)
  assert.deepEqual((await grant.assemble(a, assembly)).tools, assembly.tools)
  assert.match(notice(await grant.step(a)), /用户已通过选择框授权/)
  assert.equal(grant.call(a), undefined)

  const decline = harness({ maxToolCalls: 1 }), b = decline.agent()
  decline.reply({ answers: [{ id: 'fast-mode-authorization', selected: [], custom: '先这样吧' }] })
  await decline.step(b); decline.call(b)
  assert.deepEqual((await decline.assemble(b, assembly)).tools, [])
  assert.match(notice(await decline.step(b)), /现在仅回答/)
  assert.match(decline.call(b), /预算已用尽/)
})

test('无应答者、抛错、超时与取消都退回原有强制回答，不虚构选择', async () => {
  for (const mode of ['absent', 'throw', 'timeout']) {
    const h = harness({ maxToolCalls: 1, authorizePromptTimeoutMs: 20, userQuestions: mode !== 'absent' }), agent = h.agent()
    if (mode === 'throw') h.asked.push = () => { throw new Error('无应答者') }
    if (mode === 'timeout') h.reply(undefined)
    await h.step(agent); h.call(agent)
    assert.deepEqual((await h.assemble(agent, { tools: [{ name: 'inspect' }] })).tools, [], mode)
    const answer = await h.step(agent)
    assert.match(notice(answer), /现在仅回答/, mode)
    assert.match(h.call(agent), /预算已用尽/, mode)
    assert.equal(agent.session.records.filter(([, data]) => data.source?.form === 'authorization-choice').length, 0, mode)
  }
})

test('选择框可关闭，且不影响文本授权路径', async () => {
  const h = harness({ maxToolCalls: 1, authorizePrompt: false }), agent = h.agent()
  await h.step(agent); h.call(agent)
  assert.deepEqual((await h.assemble(agent, { tools: [{ name: 'inspect' }] })).tools, [])
  assert.equal(h.asked.length, 0)
  assert.match(notice(await h.step(agent)), /现在仅回答/)
  const grant = harness({ maxToolCalls: 1 }), g = grant.agent()
  assert.match(notice(await grant.step(g, [grant.user('同意授权')])), /用户已明确授权/)
})
