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
      ? '快速模式执行提醒：简短规划后立即执行，不在内部完整排演代码。复杂创作先把用户要求列为简短验收清单，第一批必要操作写出核心场景与主要交互的最小可运行版本，再逐批补齐其余功能，不一次生成整套大页面；已有文件仍须先读取。工作目录已知时不单独确认环境，优先使用现有工具。按核心流程成功、交互可触发、镜头无遮挡和运行无异常等要求验收，未实测项明确标注。每步推进实现或排除已观察到的故障。'
      : `快速模式收尾提醒：本回合已经执行 ${step - 1} 个模型步骤。简单状态或清单请根据已有证据回答，未知部分注明未确认，不扩展调查。复杂创作复用验收清单：尚未落盘先写核心可运行版本，随后补齐所有明确要求。只针对已观察到的问题迭代；同一问题连续两次修改未改善时先取证定位，不继续盲调参数。检查实际输出中的失败，工具成功或截图生成不等于验证通过。清单与必要检查全部通过后立即交付，不追加可选美化；未达标继续修复，未实测或阻塞项如实说明，不因步骤多提前停止。`
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
    if (payload?.agent?.session?.header?.agentPreset !== preset) return resolved
    const result = { ...resolved }
    if (result.reasoningEffort == null) result.reasoningEffort = effort
    if (result.maxTokens == null && maxTokens != null) result.maxTokens = maxTokens
    return result
  })
}
