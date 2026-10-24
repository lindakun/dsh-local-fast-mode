/**
 * fast-mode-tuning — lower the reasoning effort for sessions composed from the
 * `fast` agent preset.
 *
 * The `fast` preset exists for latency: a user who picks it is saying "answer
 * me now". Reasoning tokens dominate wall-clock time on this deployment (they
 * are ~11x the visible answer and correlate r=0.93 with per-step latency), so
 * the preset's tool surface and persona discipline are only half the job.
 *
 * Two invariants:
 *  - Never throw. A tuning row that rejects a request would brick every turn
 *    of the session it was meant to speed up, so every step is guarded and a
 *    failure returns the untouched request.
 *  - Only touch sessions whose recorded preset is `fast`. This row is mounted
 *    by the fast preset's standing scope, but `agent/request` is dispatched on
 *    the agent's carrier context, so the preset id is checked explicitly
 *    rather than assumed.
 *
 * Source: modelled on the model-selection wiring in
 * `@deepseek-ai/dsh-agent` (`installModelSelection`), which also rewrites the
 * resolved request config after `next()`.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fast-mode-tuning'

/** No services are required; the row degrades to a no-op without them. */
export const inject = []

const DEFAULT_PRESET = 'fast'
const DEFAULT_EFFORT = 'low'

function presetOf(agent) {
  try {
    return agent?.session?.header?.agentPreset
  } catch {
    return undefined
  }
}

/**
 * @param ctx - the preset's standing scope.
 * @param config - `{ preset?, reasoningEffort? }`.
 */
export function apply(ctx, config = {}) {
  const preset = typeof config.preset === 'string' && config.preset !== '' ? config.preset : DEFAULT_PRESET
  const effort = typeof config.reasoningEffort === 'string' && config.reasoningEffort !== ''
    ? config.reasoningEffort
    : DEFAULT_EFFORT

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    try {
      if (presetOf(payload?.agent) !== preset) return resolved
      // Drop any inherited effort first: the selected value must win outright,
      // not merge with a provider default that a lower tier cannot express.
      const { reasoningEffort: _inherited, ...rest } = resolved ?? {}
      return { ...rest, reasoningEffort: effort }
    } catch {
      return resolved
    }
  })
}
