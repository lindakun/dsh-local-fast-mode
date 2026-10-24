/** 快速模式提供可选请求预算及执行提醒，保留会话和界面显式选择。 */
export const name = 'fast-mode-tuning'
export const inject = []

export function apply(ctx, config = {}) {
  const preset = config.preset ?? 'fast'
  const effort = config.reasoningEffort ?? 'low'
  const maxTokens = config.maxTokens
  if (maxTokens != null && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) {
    throw new RangeError('maxTokens 必须为正整数')
  }
  const steps = new WeakMap()

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (agent?.session?.header?.agentPreset !== preset || decision.kind !== 'enter') return decision
    const fresh = messages.some(message => message.source?.kind === 'user')
    const step = fresh ? 1 : (steps.get(agent) ?? 0) + 1
    steps.set(agent, step)
    if (step !== 1 && (step < 3 || step % 2 === 0)) return decision
    const text = step === 1
      ? '快速模式执行提醒：用简短规划选定一个可行方案后立即执行，不要在内部完整排演代码、重复宣布即将开始或反复比较装饰细节。新建页面、脚本等产物时，优先在第一批必要操作中写出最小可运行版本，再根据实际运行结果修正；已有文件仍须先读取。工作目录已在上下文给出时，不要仅为确认目录或浏览器是否存在而耗费单独一步。复杂任务每步也必须推进实际实现或排除已观察到的故障。'
      : `快速模式收尾提醒：本回合已经执行 ${step - 1} 个模型步骤。简单状态或清单请现在根据已有证据回答，未知部分注明未确认，不继续扩展调查。创建产物的任务若尚未落盘，请先实现可运行版本；已经可运行后根据实际检查结果继续迭代，满足用户要求再交付。视觉检查发现质量问题时应继续修改和复查，不能仅因步骤多而提前停止。复杂开发仍须完成用户明确要求的功能和必要验证。`
    // 首步强调落地执行，此后每两步提醒聚焦目标；不限制必要的质量迭代。
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
    if (payload?.agent?.session?.header?.agentPreset !== preset) return resolved
    const result = { ...resolved }
    if (result.reasoningEffort == null) result.reasoningEffort = effort
    if (result.maxTokens == null && maxTokens != null) result.maxTokens = maxTokens
    return result
  })
}
