/** 快速模式限制取证预算，完整执行模式保留必要工作；均通过公开接口生效。 */
import { createHash } from 'node:crypto'
import { userAuthorization, replyAuthorization, dialogAuthorization, DIALOG_SOURCE, DIALOG_FORM, DIALOG_QUESTION_ID } from './authorization.mjs'
export const name = 'fast-mode-tuning'
export const inject = ['agentPresets', 'tools']

/** 选择框的快捷选项文案；自由输入始终保留，用户不必二选一。 */
export const GRANT_LABEL = '继续深入'
export const DECLINE_LABEL = '就此交付'
/** 触发强制回答的原因，决定提示文案；两者都与“批次/次数预算”不是一回事。 */
export const LIMIT_BUDGET = 'budget'
export const LIMIT_TIMEOUT = 'timeout'
/**
 * 空转提示：判据是“连续多批没有拿到新信息”，不是“有没有写过文件”。
 * 排查/分析类任务每批都有新证据，永远不会命中；反复查同一处、命令原地打转才会命中。
 * 只提示、不拒绝工具：误判的代价只是多一句话，而不是逼模型造一个无用文件来解锁。
 */
export const STALL_TEXT = rounds => `最近 ${rounds} 批工具调用没有获得新信息（结果与上一批重复，或内容近乎为空）。如果当前是产出型任务，请先把最小可运行版本写入磁盘再继续；如果这是排查或分析任务，忽略本条提示，按计划继续取证即可。工具不会被限制。`
/**
 * 结果签名只取“内容有没有变化”，不读模型自述、也不判断任务类型。
 * 同一条命令重复跑、空结果、被截断回到同一段文本，都会得到同一签名。
 */
export const resultSignature = message => {
  const text = (message?.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n').slice(0, 512)
  return `${message?.isError === true ? 'E' : 'O'}:${createHash('sha1').update(text).digest('hex')}`
}
/** 合法思考档位，仅用于校验配置；快速模式不靠降档省时间，保留用户显式选择。 */
export const EFFORTS = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'max']
const rankOf = value => (typeof value === 'string' && EFFORTS.includes(value.toLowerCase()) ? value : undefined)
const limitTitle = limit => limit === LIMIT_TIMEOUT ? '单次工具执行超时' : '取证预算已用尽'
const dialogQuestions = (timeoutMs, limit = LIMIT_BUDGET) => [{
  id: DIALOG_QUESTION_ID,
  header: limitTitle(limit),
  question: limit === LIMIT_TIMEOUT
    ? '有一次工具调用超过单次执行上限被中止。要继续深入，还是按现有材料交付？也可以直接输入你的要求。'
    : '本轮取证预算已用尽。要继续深入，还是按现有材料交付？也可以直接输入你的要求。',
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
  // 单次请求输出预算的硬顶：快速模式只在更省时才生效，完整执行模式不设。
  const maxOutputTokens = config.maxOutputTokens
  // 空转检测：连续这么多批工具调用都没有新信息时，追加一条软提示。
  // 只发提示、不拒绝工具；默认 3 批，设为 0 可关闭。
  const stallRounds = config.stallRounds ?? 3
  const maxToolRounds = config.maxToolRounds ?? 10
  const maxToolCalls = config.maxToolCalls ?? 20
  const toolTimeoutMs = config.toolTimeoutMs ?? 30000
  const authorizePrompt = config.authorizePrompt ?? true
  // 限时阻塞：窗口打开后最多等这么久。无响应对应“用户离开”，按继续深入处理，不再一直挂着。
  const authorizePromptTimeoutMs = config.authorizePromptTimeoutMs ?? 10000
  for (const [key, value] of Object.entries({ maxToolRounds, maxToolCalls, toolTimeoutMs, authorizePromptTimeoutMs, ...(maxTokens == null ? {} : { maxTokens }), ...(maxOutputTokens == null ? {} : { maxOutputTokens }) })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${key} 必须为正整数`)
  }
  if (!Number.isSafeInteger(stallRounds) || stallRounds < 0) throw new RangeError('stallRounds 必须为非负整数')
  if (rankOf(effort) === undefined) throw new RangeError(`reasoningEffort 必须是 ${EFFORTS.join('、')} 之一`)
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
  const exhausted = state => limitOf(state) !== undefined
  // 超时与批次/次数是两个不同的触发原因；同一状态可能同时满足，超时优先说明，因为它更具体。
  const limitOf = state => {
    if (!state || state.authorized) return
    if (state.timedOut) return LIMIT_TIMEOUT
    if (state.rounds >= maxToolRounds || state.calls >= maxToolCalls) return LIMIT_BUDGET
  }
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
  const askAuthorization = async (agent, signal, limit = LIMIT_BUDGET) => {
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
        .then(() => service.ask({ questions: dialogQuestions(authorizePromptTimeoutMs, limit), agent, signal: controller.signal }))
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
    // 空转检测：只比较“这批结果与上批是否一样”，不判断任务类型。
    // 排查/分析任务每批都拿到新证据，签名必然变化，因此永远不会被误判。
    if (state && event.type === 'tool/result' && event.data?.message) {
      const signature = resultSignature(event.data.message)
      if (signature === state.lastSignature) {
        state.stallStreak++
        if (stallRounds > 0 && state.stallStreak >= stallRounds) state.stall = true
      } else {
        state.stallStreak = 0
        state.lastSignature = signature
      }
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

  // 思考档位只能在步骤准备之前用 agent.model.select() 声明：运行时会把它冻结进本步的
  // selection，之后 agent/request 钩子再改写同一个字段会被断言拒绝并中断该步。
  // 因此这里在模型初始化时补一次默认档位，只在用户没有显式档位时生效；
  // 用户之后在界面显式选档会写入新的 model/selection，本插件不会覆盖。
  ctx.on('agent/created', ({ agent }) => {
    if (!modeOf(agent)) return
    const current = agent?.model?.current?.()
    if (current == null || current.reasoningEffort != null) return
    agent.model.select({ ...current, reasoningEffort: effort })
  })

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
      const answer = await askAuthorization(context.scope, context.signal, limitOf(state))
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
      state = { agent, authorized: Boolean(authorization.authorized), rounds: 0, calls: 0, step: 0, lastToolStep: null, finalStarted: false, finalLimit: null, prompted: false, timedOut: false, justAuthorized: false, defaultAuthorized: false, lastSignature: null, stallStreak: 0, stallNotified: false }
      states.set(agent, state)
      sessions.set(agent.session, state)
    }
    if (users.length) state.task = users.flatMap(message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text)).join('\n').slice(0, 600)
    state.step++
    if (mode === 'brief' && state.finalStarted) {
      // 异常模型在无工具阶段仍请求工具时不再递归重试；只提供真实的停止原因。
      agent.session.append('assistant/message', {
        turn, step: step - 1,
        message: { id: crypto.randomUUID(), role: 'assistant', source: { kind: 'fast-mode-budget', form: 'notice' }, content: [{ type: 'text', text: `${limitTitle(state.finalLimit ?? LIMIT_BUDGET)}，已停止额外操作。模型未能完成最终回答，不能据此判断任务成功。可根据已返回的材料继续，或明确选择完整执行模式。` }] },
      }, { surfaceOp: 'append' })
      return { kind: 'reject' }
    }
    // 选择框已在 system-prompt/assemble 处理；这里只读取结果。
    const limit = mode === 'brief' ? limitOf(state) : undefined
    const final = limit !== undefined
    if (final) {
      state.finalStarted = true
      state.finalLimit = limit
      authorizations.set(agent, { ...authorizationOf(agent), pending: true })
    }
    // 空转提示：只发一句话，不拒绝工具。命中后清标记，避免每步重复催促。
    if (state.stall && !final && !state.authorized && !state.stallNotified) {
      state.stall = false
      state.stallNotified = true
      return {
        ...decision,
        messages: [...decision.messages, { id: crypto.randomUUID(), role: 'user', source: { kind: 'fast-mode-budget', form: 'notice' }, content: [{ type: 'text', text: STALL_TEXT(stallRounds) }] }],
      }
    }
    // 只在首步、强制回答阶段与刚选择授权时提示，避免每步核查清单诱发反复补证据。
    if (state.step !== 1 && !final && !state.justAuthorized) return decision
    const justAuthorized = state.justAuthorized
    state.justAuthorized = false
    const text = mode === 'full' || state.authorized
      ? `${mode === 'full' ? '当前为完整执行模式。' : state.defaultAuthorized ? '授权选择框已等待超时且无人应答，按继续深入处理。' : justAuthorized ? '用户已通过选择框授权当前工作。' : '用户已明确授权当前工作。'}取证批次和工具次数预算不再限制本次工作。完成授权范围内的实现、深入调查和必要验证，不扩大授权范围；单次工具超时等其他设置保持不变。`
      : limit === LIMIT_TIMEOUT
        ? `有一次工具调用超过单次执行上限被中止，工具已不可用。现在仅回答：已确认结论、关键依据、未知疑点和必要建议；不要重发同样耗时的命令，也不要假设尚未返回的结果。需要重新取证的疑点留给用户决定是否继续。`
        : final
          ? '本轮取证已结束，工具不可用。现在仅回答：已确认结论、关键依据、未知疑点和必要建议。不再请求工具，不补齐全部未知，不宣称已完成未验证事项。需要深入取证的疑点留给用户决定是否继续。'
          : `当前为快速模式：默认先返回已确认结论。优先取得核心材料并合并独立操作；证据有限就收窄措辞，不为消除疑点递归调查。最多 ${maxToolRounds} 个取证批次、${maxToolCalls} 次工具调用；这是上限，不是目标，能回答就提前交付。未知疑点及继续调查的价值简短列出，等待用户确认。需要创建产物时先写最小可运行版本；已有内容先读取。（思考档位按你的选择保留，空转由单步输出预算和先落盘约束。）`
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
      return state?.timedOut
        ? '单次工具执行已超时被中止，请输出已确认结论和未确认疑点：命令本身没有失败，但本次调用没有结果，重发同样耗时的命令会再次超时。'
        : '本轮取证预算已用尽，请输出已确认结论和未确认疑点，等待用户决定是否继续。'
    }
    // 在任何异步等待之前占用额度，避免同批并发调用突破上限；失败尝试也计数。
    state.calls++
    if (state.lastToolStep !== state.step) { state.rounds++; state.lastToolStep = state.step }
  })

  // 取消原因不会渲染进命令输出：本插件发出的取消必须自己把上限告诉模型，
  // 否则模型只看到 “Error: tool call aborted”，会继续下同样超时的命令。
  const timedOutText = (name, ms) => {
    // 毫秒级配置用于测试，不要渲染成「约 0 秒」。
    const cap = ms >= 1000 ? `约 ${Math.round(ms / 1000)} 秒` : `仅 ${ms} 毫秒`
    const budget = Math.max(Math.floor((ms - 5000) / 1000), 1)
    return [
      `Error: ${name} command timed out after ${ms}ms.`,
      `这是快速模式的单次工具上限（toolTimeoutMs=${ms}，${cap}），不是命令失败，也不是用户取消；调大 timeoutMs 或命令自身的 --max-time 不会延长它。`,
      `重发时把单次调用压到 ${budget} 秒以内：缩短 --max-time、减少 ping/curl 的次数，或把串行测量拆成多次调用。`,
    ].join('\n')
  }
  // 结果只记录“哪个调用被本插件的计时器截断”，避免跨调用串味。
  const deadlines = new WeakMap()

  ctx.on('tools/execute', async (exec, next) => {
    if (modeOf(exec.agent) !== 'brief') return next()
    const state = states.get(exec.agent)
    const original = exec.signal
    const controller = new AbortController()
    const timer = setTimeout(() => {
      if (state) state.timedOut = true
      deadlines.set(exec, toolTimeoutMs)
      controller.abort(new Error('快速模式单次工具取证超时，请先交付已有结论'))
    }, toolTimeoutMs)
    exec.signal = AbortSignal.any([original, controller.signal])
    try { return await next() } finally { clearTimeout(timer); exec.signal = original }
  })

  // DSH 会把“已开始执行后被取消”的成功结果替换成固定的 “Error: tool call aborted”，
  // 并在 post-execute 之后才做这一步；因此这里只改写失败结果，才不会被覆盖，
  // 且不影响成功结果、上游错误与用户取消（它们不带本插件记录的上限）。
  const ABORTED_TEXT = 'Error: tool call aborted'
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || !result.isError) return decision
    const ms = deadlines.get(exec)
    if (ms === undefined) return decision
    deadlines.delete(exec)
    // 只替换 DSH 那条不含信息的取消文案，工具自身抛出的错误正文保持原样。
    const blocks = result.content ?? []
    const keep = blocks[0]?.type === 'text' && blocks[0].text === ABORTED_TEXT ? blocks.slice(1) : blocks
    // 工具自身抛出的错误仍然保留，单独成段，避免和上限说明粘成一行。
    const text = keep.length > 0 ? `${timedOutText(exec.name, ms)}\n` : timedOutText(exec.name, ms)
    return { ...decision, content: [{ type: 'text', text }, ...keep] }
  })

  // 请求钩子只调整输出预算。思考档位属于步骤准备时冻结的 selection：
  // 在这里事后改写 reasoningEffort 会被运行时的断言直接拒绝并中断该步骤，
  // 因此档位一律走上方的 agent.model.select()，不进入这个 waterfall。
  // 完整执行模式用于长实现，不设上限，避免把必要的长输出截断。
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const mode = modeOf(payload?.agent)
    if (!mode) return resolved
    const result = { ...resolved }
    if (mode === 'brief' && maxOutputTokens != null && (result.maxTokens == null || result.maxTokens > maxOutputTokens)) result.maxTokens = maxOutputTokens
    else if (result.maxTokens == null && maxTokens != null) result.maxTokens = maxTokens
    return result
  })
}
