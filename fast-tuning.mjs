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
    const fresh = messages.some(message => message.source?.kind === 'user')
    const step = fresh ? 1 : (steps.get(agent) ?? 0) + 1
    steps.set(agent, step)
    if (step !== 1 && (step < 3 || step % 2 === 0)) return decision
    const text = step === 1
      ? '快速模式执行提醒：简短规划后立即执行，不在内部完整排演代码。调查与诊断先明确对象、范围和交付条件，按数据结构筛选并汇总证据；补查要能区分假设，证据足以回答时交付，未知根因标注。复杂创作先列简短验收清单，写核心场景与主要交互的最小可运行版本，再补齐全部要求，不一次生成整套大页面；已有文件先读取。复用已知入口和现有工具，区分执行失败与目标故障，每步推进实现或取得有用证据。'
      : `快速模式收尾提醒：本回合已经执行 ${step - 1} 个模型步骤。简单查询根据已有证据回答。调查与诊断复用已确认范围、统计和检查结果；状态未变且重复失败未增加证据时停止相同探测，转向能区分假设的新证据。足以回答问题和提出方案时交付，区分事实、推断和未知，不穷尽替代路径；明确要求深入定位、修复或验证时完成该范围内必要工作。创作按验收清单补齐要求，同一问题两次修改未改善先重新定位。检查实际失败，工具成功不等于验收通过；必要检查通过后交付，不追加可选美化，未实测或阻塞项如实说明。`
    // 首步强调分阶段落盘，此后每两步提醒按验收清单推进；不限制必要的质量迭代。
    return {
      ...decision,
      messages: [...decision.messages, {
        id: crypto.randomUUID(),
        role: 'user',
        source: { kind: 'fast-mode-budget', form: 'notice' },
        content: [{ type: 'text', text }],
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
