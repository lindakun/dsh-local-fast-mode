/** 只从真实用户的直接指令识别本次工作的预算授权；不改变 DSH 权限。 */

/** 插件写入会话的选择结果标识：不是真实用户输入，只用于恢复会话时重放。 */
export const DIALOG_SOURCE = 'fast-mode-budget'
export const DIALOG_FORM = 'authorization-choice'
export const DIALOG_QUESTION_ID = 'fast-mode-authorization'

/**
 * 读取选择框写回的授权决定。决定已在弹窗当下解析成 grant/decline 再落盘，
 * 恢复会话时无需重新做文本匹配，结果与用户当时的选择一致。
 */
export function dialogAuthorization(previous = {}, message) {
  const source = message?.source
  if (source?.kind !== DIALOG_SOURCE || source.form !== DIALOG_FORM) return previous
  const input = message.id ?? message
  if (previous.input === input) return previous
  if (source.choice === 'grant') return { authorized: true, pending: false, input }
  return { authorized: false, pending: false, input }
}

function directClauses(text) {
  return text
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
    .replace(/^\s*>.*$/gm, '')
    .replace(/`[^`]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/g, '')
    .split(/[，,。；;！!？?\n]+/)
    .map(clause => clause.trim().replace(/^(?:另外|然后|接着|那就|那么|所以|好的?|可以)[、\s]*/, '').trim())
    .filter(Boolean)
}

export function userAuthorization(previous = {}, message) {
  if (message.source?.kind !== 'user') return previous
  const input = message.id ?? message
  if (previous.input === input) return previous
  const text = (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
  const clauses = directClauses(text)
  const revoke = clauses.some(clause => /^(?:请|我|现在|先)*(?:(?:恢复|启用|保留).{0,8}(?:预算|限制)|(?:不要|不用|无需|不必|别|禁止|没有授权|未授权).{0,8}(?:深入|排查|调查|执行|实施|修复|继续|解除))/u.test(clause) || /^(?:please\s+)?(?:stop|do not|don't)\s+(?:investigating|investigate|continue|proceed|execute)|^restore\s+(?:the\s+)?(?:budget|limits)/i.test(clause))
  if (revoke) return { authorized: false, pending: false, input }
  const grant = clauses.some(clause => {
    if (/^(?:请你|请|帮我|给我)?(?:解释|说明|介绍|分析|如何|怎么|为什么|是否|能否)|^(?:修复|执行|实施|部署|修改)(?:方案|方法|步骤|建议|原理|预算|结果|的结果|情况|权限|是什么|后|之前|之后)/u.test(clause)) return false
    return /^(?:请你|请|麻烦你|麻烦|帮我|给我|你可以|现在|直接|立即|就|先|开始|继续)*(?:深入(?:排查|调查|分析|研究|定位)|继续(?:深入|排查|调查|执行|实施|修复|处理|完成)|执行|实施|动手|修复|实现|修改|部署|把.{1,60}(?:修复|实现|修改|部署|改掉|完成)|解除.{0,8}(?:预算|限制)|(?:我)?(?:已|已经)?(?:明确)?(?:同意|批准)?授权)/u.test(clause) || /^(?:请你|请|麻烦你|麻烦|帮我|给我|你可以|现在|直接|立即|就|先|开始|继续)*(?:我)?(?:同意|批准|确认)(?:授权|继续|深入|执行|实施)?$/u.test(clause) || /^(?:please\s+|can you\s+|could you\s+)?(?:go ahead(?:\s+and)?|proceed|continue\s+(?:investigating|investigation|execution)|investigate\s+(?:deeply|thoroughly)|implement|fix|execute|deploy|remove\s+(?:the\s+)?(?:budget|limits))\b/i.test(clause)
  })
  const confirm = /^(?:好|好的|可以|同意|确认|是的|行|yes(?:\s+please)?|ok|okay)[。.!！\s]*$/i.test(text)
  const followup = /^(?:继续(?:吧)?|接着做|继续处理|进度(?:如何|怎样|呢)|现在(?:怎么样|进展如何)|做到哪了|continue|status(?: update)?|how is it going)[。.!！?？\s]*$/i.test(text)
  const proceed = /^(?:(?:好(?:的)?|可以|行)[，,\s]*)?(?:继续(?:吧)?|开始(?:吧)?|动手(?:吧)?|(?:please\s+)?continue|go ahead|proceed)[。.!！\s]*$/i.test(text)
  return { authorized: grant || proceed || (Boolean(previous.pending) && confirm) || (Boolean(previous.authorized) && followup), pending: false, input }
}

export function replyAuthorization(previous = {}, message) {
  if (message.source?.kind !== 'model' || message.content.some(block => block.type === 'tool-call')) return previous
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const pending = directClauses(text).some(clause => {
    if (/(?:不|无需|不用|不要|不必|别|禁止).{0,4}(?:需要我|要我|继续|深入|动手|实施|执行|修复)/u.test(clause)) return false
    return /(?:是否|要不要|需要我|要我|可以).{0,24}(?:继续|深入|动手|实施|执行|修复)|(?:shall|should|may|can)\s+I\s+(?:continue|proceed|investigate|implement|fix)/i.test(clause)
  })
  return { ...previous, pending: Boolean(previous.pending) || pending }
}
