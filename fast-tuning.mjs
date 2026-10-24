/** 快速模式只提供缺省思考强度，保留会话和界面显式选择。 */
export const name = 'fast-mode-tuning'
export const inject = []

export function apply(ctx, config = {}) {
  const preset = config.preset ?? 'fast'
  const effort = config.reasoningEffort ?? 'low'
  const steps = new WeakMap()

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (agent?.session?.header?.agentPreset !== preset || decision.kind !== 'enter') return decision
    const fresh = messages.some(message => message.source?.kind === 'user')
    const step = fresh ? 1 : (steps.get(agent) ?? 0) + 1
    steps.set(agent, step)
    if (step < 3 || step % 2 === 0) return decision
    // 每两批提醒一次，帮助模型收尾；不强制中断复杂开发或拒绝工具。
    return {
      ...decision,
      messages: [...decision.messages, {
        id: crypto.randomUUID(),
        role: 'user',
        source: { kind: 'fast-mode-budget', form: 'notice' },
        content: [{ type: 'text', text: `快速模式收尾提醒：本回合已经执行 ${step - 1} 个模型步骤。如果用户只问简单状态或清单，请现在直接根据已有证据回答，未知部分注明未确认；不要继续检查其他 profile、客户端或进程。只有用户明确要求的复杂开发或全面排查才继续必要工作。` }],
      }],
    }
  })

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    if (payload?.agent?.session?.header?.agentPreset !== preset) return resolved
    if (resolved?.reasoningEffort != null) return resolved
    return { ...resolved, reasoningEffort: effort }
  })
}
