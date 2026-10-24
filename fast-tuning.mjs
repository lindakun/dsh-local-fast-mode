/** 快速模式提供可选请求预算及执行提醒，保留会话和界面显式选择。 */
export const name = 'fast-mode-tuning'
export const inject = ['agentPresets']

export function apply(ctx, config = {}) {
  const preset = config.preset ?? 'fast'
  const effort = config.reasoningEffort ?? 'low'
  const maxTokens = config.maxTokens
  if (maxTokens != null && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) {
    throw new RangeError('maxTokens 必须为正整数')
  }
  const steps = new WeakMap()
  // header 只记录创建时的预设，切换后必须查询当前实际挂载的预设。
  const isActive = agent => agent?.ctx != null && ctx.agentPresets.composedPreset(agent.ctx) === preset

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (!isActive(agent)) {
      if (agent) steps.delete(agent)
      return decision
    }
    if (decision.kind !== 'enter') return decision
    const users = messages.filter(message => message.source?.kind === 'user')
    const previous = steps.get(agent)
    const step = users.length ? 1 : (previous?.step ?? 0) + 1
    // 只复用真实用户消息，避免把工具结果或插件通知当成新的任务目标。
    const task = users.length
      ? users.flatMap(message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text)).join('\n').slice(0, 1200)
      : previous?.task
    steps.set(agent, { step, task })
    const text = step === 1
      ? '快速模式执行提醒：简短规划后执行。每次调用工具前先判断已有证据是否足以交付；已覆盖所问范围、主要异常与影响时立即回答，不为深入而再查旧副本或外部系统。先确认对象、时间或版本、数据来源和时效。所需数据缺失且无有效入口时报告缺口，不用背景材料替代。审计先覆盖主要类别，不被单个异常带走；补查必须改变当前结论或方案，访问失败不自动变成广泛发现。创作先写核心交互的最小可运行版本，再补齐要求；已有文件先读取，不在内部完整排演代码。'
      : `快速模式收尾提醒：本回合已经执行 ${step - 1} 个模型步骤。先对照下方用户请求和刚返回的证据：足以回答，或所需数据缺失且无有效入口时，直接交付结论与缺口。否则只做能改变所需结论、方案或完成必要验收的下一步；不以历史副本或外部调查替代当前任务，审计覆盖全貌，修复和创作仍须完成明确要求。`
    // 每步返回证据后重新对照用户目标，不强制取消任务或限制工具。
    return {
      ...decision,
      messages: [...decision.messages, {
        id: crypto.randomUUID(),
        role: 'user',
        source: { kind: 'fast-mode-budget', form: 'notice' },
        content: [{ type: 'text', text: task ? `${text}\n本回合用户请求摘录（最多 1200 字符，完整请求以原消息为准）：\n${task}` : text }],
      }],
    }
  })

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    if (!isActive(payload?.agent)) return resolved
    const result = { ...resolved }
    if (result.reasoningEffort == null) result.reasoningEffort = effort
    if (result.maxTokens == null && maxTokens != null) result.maxTokens = maxTokens
    return result
  })
}
