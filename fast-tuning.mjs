/** 快速模式限制取证预算，完整执行模式保留必要工作；均通过公开接口生效。 */
export const name = 'fast-mode-tuning'
export const inject = ['agentPresets', 'tools']

export function apply(ctx, config = {}) {
  const preset = config.preset ?? 'fast'
  const fullPreset = config.fullPreset ?? 'fast-full'
  const effort = config.reasoningEffort ?? 'low'
  const maxTokens = config.maxTokens
  const maxToolRounds = config.maxToolRounds ?? 5
  const maxToolCalls = config.maxToolCalls ?? 10
  const toolTimeoutMs = config.toolTimeoutMs ?? 15000
  for (const [key, value] of Object.entries({ maxToolRounds, maxToolCalls, toolTimeoutMs, ...(maxTokens == null ? {} : { maxTokens }) })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${key} 必须为正整数`)
  }
  if (preset === fullPreset) throw new RangeError('快速模式与完整执行模式的预设 ID 不能相同')
  const states = new WeakMap()
  const sessions = new WeakMap()
  const modeOf = agent => {
    if (agent?.ctx == null) return
    const current = ctx.agentPresets.composedPreset(agent.ctx)
    if (current === preset) return 'brief'
    if (current === fullPreset) return 'full'
  }
  const exhausted = state => state && (state.rounds >= maxToolRounds || state.calls >= maxToolCalls || state.timedOut)
  const reset = agent => { states.delete(agent); if (agent?.session) sessions.delete(agent.session) }

  // 无效工具名也属于模型发起的取证批次，不能靠执行前校验失败绕过轮数预算。
  ctx.on('session/event', (session, event) => {
    const state = sessions.get(session)
    if (state && event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'tool-call') && state.lastToolStep !== state.step) {
      state.rounds++
      state.lastToolStep = state.step
    }
  })

  // 入队时重置，确保新用户请求在提示组装前恢复工具；通知和工具结果不重置预算。
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source?.kind === 'user') reset(agent)
  })
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') reset(agent) })
  ctx.on('agent/disposed', ({ agent }) => reset(agent))

  // 组装结果会由 DSH 正常记录；不在供应商请求出口静默改写工具清单。
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (modeOf(context.scope) !== 'brief' || !exhausted(states.get(context.scope))) return assembly
    return { ...assembly, tools: [] }
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next) => {
    const decision = await next()
    const mode = modeOf(agent)
    if (!mode) { reset(agent); return decision }
    if (decision.kind !== 'enter') return decision
    const users = messages.filter(message => message.source?.kind === 'user')
    let state = states.get(agent)
    if (!state || users.length) {
      state = { rounds: 0, calls: 0, step: 0, lastToolStep: null, finalStarted: false }
      states.set(agent, state)
      sessions.set(agent.session, state)
    }
    if (users.length) state.task = users.flatMap(message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text)).join('\n').slice(0, 600)
    state.step++
    if (mode === 'brief' && state.finalStarted) {
      // 异常模型在无工具阶段仍请求工具时不再递归重试；只提供真实的预算说明。
      agent.session.append('assistant/message', {
        turn, step: step - 1,
        message: { id: crypto.randomUUID(), role: 'assistant', source: { kind: 'fast-mode-budget', form: 'notice' }, content: [{ type: 'text', text: '本轮取证预算已用尽，已停止额外操作。模型未能完成最终回答，不能据此判断任务成功。可根据已返回的材料继续，或明确选择完整执行模式。' }] },
      }, { surfaceOp: 'append' })
      return { kind: 'reject' }
    }
    const final = mode === 'brief' && exhausted(state)
    if (final) state.finalStarted = true
    // 只在首步与强制回答阶段提示，避免每步核查清单诱发反复补证据。
    if (state.step !== 1 && !final) return decision
    const text = mode === 'full'
      ? '当前为完整执行模式：完成用户明确要求的实现、深入调查和必要验证。简短规划后执行，复用证据，结论不超出验证范围，不扩大任务。'
      : final
        ? '本轮取证已结束，工具不可用。现在仅回答：已确认结论、关键依据、未知疑点和必要建议。不再请求工具，不补齐全部未知，不宣称已完成未验证事项。需要深入取证的疑点留给用户决定是否继续。'
        : `当前为快速模式：默认先返回已确认结论。优先取得核心材料并合并独立操作；证据有限就收窄措辞，不为消除疑点递归调查。最多 ${maxToolRounds} 个取证批次、${maxToolCalls} 次工具调用；这是上限，不是目标，能回答就提前交付。未知疑点及继续调查的价值简短列出，等待用户确认。需要创建产物时先写最小可运行版本；已有内容先读取。`
    return {
      ...decision,
      messages: [...decision.messages, { id: crypto.randomUUID(), role: 'user', source: { kind: 'fast-mode-budget', form: 'notice' }, content: [{ type: 'text', text: state.task ? `${text}\n本回合用户请求摘录（最多 600 字符，完整要求以原消息为准）：\n${state.task}` : text }] }],
    }
  })

  ctx.tools.guard(exec => {
    if (modeOf(exec.agent) !== 'brief') return
    const state = states.get(exec.agent)
    if (!state || state.finalStarted || state.timedOut || state.calls >= maxToolCalls || (state.lastToolStep !== state.step && state.rounds >= maxToolRounds)) {
      return '本轮取证预算已用尽，请输出已确认结论和未确认疑点，等待用户决定是否继续。'
    }
    // 在任何异步等待之前占用额度，避免同批并发调用突破上限；失败尝试也计数。
    state.calls++
    if (state.lastToolStep !== state.step) { state.rounds++; state.lastToolStep = state.step }
    if (['bash', 'pwsh'].includes(exec.name) && exec.arguments?.run_in_background === true) {
      return '快速模式不启动后台工作，请先交付已有结论；需要长期执行时选择完整执行模式。'
    }
  })

  ctx.on('tools/execute', async (exec, next) => {
    if (modeOf(exec.agent) !== 'brief') return next()
    const state = states.get(exec.agent)
    const original = exec.signal
    const controller = new AbortController()
    const timer = setTimeout(() => {
      if (state) state.timedOut = true
      controller.abort(new Error('快速模式单次工具取证超时，请先交付已有结论'))
    }, toolTimeoutMs)
    exec.signal = AbortSignal.any([original, controller.signal])
    try { return await next() } finally { clearTimeout(timer); exec.signal = original }
  })

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    if (!modeOf(payload?.agent)) return resolved
    const result = { ...resolved }
    if (result.reasoningEffort == null) result.reasoningEffort = effort
    if (result.maxTokens == null && maxTokens != null) result.maxTokens = maxTokens
    return result
  })
}
