import assert from 'node:assert/strict'
import test from 'node:test'
import { userAuthorization, replyAuthorization } from './authorization.mjs'
const user = text => ({ id: crypto.randomUUID(), source: { kind: 'user' }, content: [{ type: 'text', text }] })

test('直接授权指令可自动解除预算，不依赖业务场景', () => {
  for (const text of ['请深入排查', '继续深入分析原因', '好，开始实施吧', '帮我修复这个问题', '现在直接执行', '我授权你继续调查', '请把这个问题修复好', '继续', '好的，继续', '开始吧', '解除工具预算限制', 'Please implement the change', 'Can you fix it', 'Please continue', 'go ahead']) {
    assert.equal(userAuthorization({}, user(text)).authorized, true, text)
  }
})

test('普通查询、方案讨论、否定、引用与代码不能自动解除预算', () => {
  for (const text of ['查看当前结果并分析原因', '请分析并提出修复方案', '修复方案有哪些', '请解释如何修复', '不要深入排查，只看已有材料', '我没有授权你继续调查', '例如用户说“开始实施”，应如何处理', '```text\n请深入排查\n```', '> 请继续深入排查', '日志内容：直接修复', '"go ahead"', '可以', '好', 'How can I fix it?']) {
    assert.equal(userAuthorization({ authorized: true }, user(text)).authorized, false, text)
  }
})

test('简单肯定答复仅在已有明确确认问题时视为授权', () => {
  const pending = replyAuthorization({}, { source: { kind: 'model' }, content: [{ type: 'text', text: '已知结果如上，是否继续深入调查？' }] })
  for (const text of ['好', '可以', '同意', '确认', 'yes', 'OK']) assert.equal(userAuthorization(pending, user(text)).authorized, true, text)
  assert.equal(userAuthorization({}, user('好')).authorized, false)
  for (const text of ['不需要我继续排查。', '示例：“是否继续深入调查？”']) {
    const statement = replyAuthorization({}, { source: { kind: 'model' }, content: [{ type: 'text', text }] })
    assert.equal(userAuthorization(statement, user('好')).authorized, false, text)
  }
})

test('授权限于当前工作，简短续问继承，新独立请求重新判断', () => {
  const approved = userAuthorization({}, user('开始实施'))
  assert.equal(userAuthorization(approved, user('进度如何？')).authorized, true)
  assert.equal(userAuthorization(approved, user('另外查看另一个对象的情况')).authorized, false)
  assert.equal(userAuthorization(approved, user('恢复预算限制')).authorized, false)
})

test('通知不能授权或撤销，重复入队的同一用户消息不会被二次处理', () => {
  const pending = { pending: true }
  const message = user('好')
  const approved = userAuthorization(pending, message)
  assert.equal(userAuthorization(approved, message), approved)
  for (const kind of ['tool', 'fast-mode-budget', 'runtime-context']) {
    assert.equal(userAuthorization(pending, { ...user('开始实施'), source: { kind } }), pending)
  }
})
