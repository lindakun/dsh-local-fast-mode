/** 快速模式限制取证预算，完整执行模式保留必要工作；均通过公开接口生效。 */
import { userAuthorization, replyAuthorization, dialogAuthorization, DIALOG_SOURCE, DIALOG_FORM, DIALOG_QUESTION_ID } from './authorization.mjs'
export const name = 'fast-mode-tuning'
export const inject = ['agentPresets', 'tools']

/** 选择框的快捷选项文案；自由输入始终保留，用户不必二选一。 */
export const GRANT_LABEL = '继续深入'
export const DECLINE_LABEL = '就此交付'
const dialogQuestions = timeoutMs => [{
  id: DIALOG_QUESTION_ID,
  header: '取证预算已用尽',
  question: '本轮取证预算已用尽。要继续深入，还是按现有材料交付？也可以直接输入你的要求。',
  detail: `选择“继续深入”会解除本次工作的取证批次和工具次数限制，完成后再交付；“就此交付”会停止调用工具，只给出已确认结论和未确认疑点。若你另有安排，请在输入框写明，我会按你的文字判断。${Math.round(timeoutMs / 1000)} 秒内无任何响应时，视为你已离开，按“继续深入”自动继续。`,
  options: [
    { label: GRANT_LABEL, description: '解除本次工作的取证批次与工具次数预算，继续完成剩余工作。' },
    { label: DECLINE_LABEL, description: '不再调用工具，按现有材料给出结论与未确认疑点。' },
  ],
  multiSelect: false,
}]

export function apply(ctx, config = {}) {
  const preset = config.preset ?? 'fast'
  const fullPreset = config.fullPreset ?? 'fast-full'
  const effort = config.reasoningEffort ?? 'low'
  const maxTokens = config.maxTokens
  const maxToolRounds = config.maxToolRounds ?? 10
  const maxToolCalls = config.maxToolCalls ?? 20
  const toolTimeoutMs = config.toolTimeoutMs ?? 30000
  const authorizePrompt = config.authorizePrompt ?? true
  // 限时阻塞：窗口打开后最多等这么久。无响应对应“用户离开”，按继续深入处理，不再一直挂着。
  const authorizePromptTimeoutMs = config.authorizePromptTimeoutMs ?? 10000
  for (const [key, value] of Object.entries({ maxToolRounds, maxToolCalls, toolTimeoutMs, authorizePromptTimeoutMs, ...(maxTokens == null ? {} : { maxTokens }) })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${key} 必须为正整数`)
  }
  if (preset === fullPreset) throw new RangeError('快速模式与完整执行模式的预设 ID 不能相同')
  const states = new WeakMap()
  const sessions = new WeakMap()
  const authorizations = new WeakMap()
  const authorizationOf = agent => {
    if (!authorizations.has(agent)) {
      let authorization = {}
      // 恢复会话时只重放本会话的真实用户输入与模型确认问题，不读取其他会话。
      for (const event of agent.session?.log ?? []) {
        if (event.type === 'user/message') authorization = dialogAuthorization(userAuthorization(authorization, event.data), event.data)
        if (event.type === 'assistant/message') authorization = replyAuthorization(authorization, event.data.message)
      }
      authorizations.set(agent, authorization)
    }
    return authorizations.get(agent)
  }
  const modeOf = agent => {
    if (agent?.ctx == null) return
    const current = ctx.agentPresets.composedPreset(agent.ctx)
    if (current === preset) return 'brief'
    if (current === fullPreset) return 'full'
  }
  const exhausted = state => state && !state.authorized && (state.rounds >= maxToolRounds || state.calls >= maxToolCalls || state.timedOut)
  const reset = agent => { states.delete(agent); if (agent?.session) sessions.delete(agent.session) }

  // 选择框只作为可选增强：服务缺失（headless、CLI）时退回原有文本路径，不改变预算语义。
  const questionService = () => (typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined)

  /** 授权决定与原始补充要求一起传递；只用 trim 判断空输入，不裁剪用户原文。 */
  const choiceOf = answer => {
    const item = answer?.answers?.find(entry => entry.id === DIALOG_QUESTION_ID)
    if (!item) return
    const selected = item.selected ?? []
    const custom = item.custom?.trim() ? item.custom : ''
    const choice = selected.includes(GRANT_LABEL) ? 'grant'
      : selected.includes(DECLINE_LABEL) ? 'decline'
        : custom && userAuthorization({}, { source: { kind: 'user' }, content: [{ type: 'text', text: custom }] }).authorized ? 'grant' : 'decline'
    return { choice, custom }
  }

  /** 询问用户并等待选择；限时阻塞，超时视为用户离开并按继续深入处理。 */
  const askAuthorization = async (agent, signal) => {
    const service = questionService()
    if (typeof service?.ask !== 'function') return
    if (signal?.aborted) return
    const controller = new AbortController()
    const forward = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forward, { once: true })
    const EXPIRED = Symbol('expired')
    let timer
    const expired = new Promise(resolve => { timer = setTimeout(() => resolve(EXPIRED), authorizePromptTimeoutMs) })
    try {
      // 服务自身的异常与回合取消都返回 undefined，退回原有强制回答路径，不虚构用户选择。
      const pending = Promise.resolve()
        .then(() => service.ask({ questions: dialogQuestions(authorizePromptTimeoutMs), agent, signal: controller.signal }))
        .then(value => ({ value }), () => ({ failed: true }))
      const outcome = await Promise.race([pending, expired])
      if (outcome === EXPIRED) {
        // 无任何响应：不写入会话事件，只在本次工作内存中按“继续深入”处理。
        controller.abort(new Error('授权选择超时'))
        return { choice: 'default-grant' }
      }
      if (outcome.failed) return
      return choiceOf(outcome.value)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    }
  }

  /** 原文进入持久化会话与模型上下文；授权重放仍以独立的 choice 字段为准。 */
  const appendChoice = (agent, { choice, custom }) => {
    const message = {
      id: crypto.randomUUID(),
      role: 'user',
      source: { kind: DIALOG_SOURCE, form: DIALOG_FORM, choice },
      content: [{ type: 'text', text: custom || (choice === 'grant' ? `我选择：${GRANT_LABEL}。` : `我选择：${DECLINE_LABEL}。`) }],
    }
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    return message
  }

  // 无效工具名也属于模型发起的取证批次，不能靠执行前校验失败绕过轮数预算。
  ctx.on('session/event', (session, event) => {
    const state = sessions.get(session)
    if (state && event.type === 'assistant/message') {
      authorizations.set(state.agent, replyAuthorization(authorizationOf(state.agent), event.data.message))
    }
    if (state && event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'tool-call') && state.lastToolStep !== state.step) {
      state.rounds++
      state.lastToolStep = state.step
    }
  })

  // 入队时重置，确保新用户请求在提示组装前恢复工具；通知和工具结果不重置预算。
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source?.kind === 'user') {
      authorizations.set(agent, userAuthorization(authorizationOf(agent), message))
      reset(agent)
    }
  })
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') reset(agent) })
  ctx.on('agent/disposed', ({ agent }) => { reset(agent); authorizations.delete(agent) })

  // 组装结果会由 DSH 正常记录；不在供应商请求出口静默改写工具清单。
  // 选择框必须在这里问：system-prompt/assemble 先于 agent/pre-step 执行，
  // 若在 pre-step 才授权，本步的工具清单已经按耗尽状态移除，无法在同一回合继续。
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (modeOf(context.scope) !== 'brief') return assembly
    const state = states.get(context.scope)
    if (!state || !exhausted(state)) return assembly
    if (authorizePrompt && !state.prompted && questionService()) {
      state.prompted = true
      const answer = await askAuthorization(context.scope, context.signal)
      if (answer?.choice === 'grant') {
        // 选择本身就是授权：落盘后本次工作不再受批次与次数限制。
        const message = appendChoice(context.scope, answer)
        authorizations.set(context.scope, dialogAuthorization(authorizationOf(context.scope), message))
        state.authorized = true
        state.finalStarted = false
        state.timedOut = false
        state.justAuthorized = true
        return assembly
      }
      if (answer?.choice === 'default-grant') {
        // 超时无人应答：按继续深入处理，但不落盘、不标记为显式授权，
        // 因此只解除本次工作的预算，不会变成对后续新请求的永久授权。
        state.authorized = true
        state.defaultAuthorized = true
        state.finalStarted = false
        state.timedOut = false
        state.justAuthorized = true
        return assembly
      }
      if (answer?.choice === 'decline') {
        appendChoice(context.scope, answer)
        authorizations.set(context.scope, { ...authorizationOf(context.scope), authorized: false, pending: false })
      }
    }
    return { ...assembly, tools: [] }
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    const decision = await next()
    const mode = modeOf(agent)
    if (!mode) { reset(agent); return decision }
    if (decision.kind !== 'enter') return decision
    const users = messages.filter(message => message.source?.kind === 'user')
    let state = states.get(agent)
    if (!state || users.length) {
      let authorization = authorizationOf(agent)
      for (const message of users) authorization = userAuthorization(authorization, message)
      authorizations.set(agent, authorization)
      state = { agent, authorized: Boolean(authorization.authorized), rounds: 0, calls: 0, step: 0, lastToolStep: null, finalStarted: false, prompted: false, timedOut: false, justAuthorized: false, defaultAuthorized: false }
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
    // 选择框已在 system-prompt/assemble 处理；这里只读取结果。
    const final = mode === 'brief' && exhausted(state)
    if (final) {
      state.finalStarted = true
      authorizations.set(agent, { ...authorizationOf(agent), pending: true })
    }
    // 只在首步、强制回答阶段与刚选择授权时提示，避免每步核查清单诱发反复补证据。
    if (state.step !== 1 && !final && !state.justAuthorized) return decision
    const justAuthorized = state.justAuthorized
    state.justAuthorized = false
    const text = mode === 'full' || state.authorized
      ? `${mode === 'full' ? '当前为完整执行模式。' : state.defaultAuthorized ? '授权选择框已等待超时且无人应答，按继续深入处理。' : justAuthorized ? '用户已通过选择框授权当前工作。' : '用户已明确授权当前工作。'}取证批次和工具次数预算不再限制本次工作。完成授权范围内的实现、深入调查和必要验证，不扩大授权范围；单次工具超时等其他设置保持不变。`
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
    if (state?.authorized) return
    if (!state || state.finalStarted || state.timedOut || state.calls >= maxToolCalls || (state.lastToolStep !== state.step && state.rounds >= maxToolRounds)) {
      return '本轮取证预算已用尽，请输出已确认结论和未确认疑点，等待用户决定是否继续。'
    }
    // 在任何异步等待之前占用额度，避免同批并发调用突破上限；失败尝试也计数。
    state.calls++
    if (state.lastToolStep !== state.step) { state.rounds++; state.lastToolStep = state.step }
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
