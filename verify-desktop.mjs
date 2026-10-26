/** 准备桌面手工对照材料，或独立检查 DSH 已生成的产物；不驱动界面、不调用模型。 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [action, directory] = process.argv.slice(2)
if (!['prepare', 'verify'].includes(action) || !directory) throw new Error('用法：node verify-desktop.mjs prepare|verify <测试目录>')
const root = resolve(directory)
const metrics = [{ service: 'api', requests: 200, errors: 10 }, { service: 'worker', requests: 100, errors: 0 }, { service: 'web', requests: 0, errors: 0 }]
const fixtures = {
  query: { 'orders.csv': 'id,status,quantity,unit_price\nA001,paid,2,19.95\nA002,paid,1,120.10\nA003,paid,3,10.00\nA004,pending,4,50.00\nA005,cancelled,1,999.00\n' },
  diagnosis: {
    'README.md': '本目录是固定测试材料，没有真实服务。只根据 current.log 与 config.json 判断当前故障，history.log 是历史资料。\n',
    'current.log': Array.from({ length: 80 }, (_, i) => i === 39
      ? '2026-10-26T20:00:40+08:00 ERROR importer request_id=Q17 code=SCHEMA_VERSION_MISMATCH client_schema=2 server_schema=3 import_rejected=true'
      : i === 40 ? '2026-10-26T20:00:41+08:00 INFO server build=3.4.0 supported_client_schema=3 target=importer'
        : `2026-10-26T20:00:${String(i % 60).padStart(2, '0')}+08:00 INFO heartbeat worker=importer seq=${i + 1} local_queue=0 connection=ready message=periodic_health_check_completed`).join('\n') + '\n',
    'config.json': JSON.stringify({ collectedAt: '2026-10-26T20:01:00+08:00', client: { schemaVersion: 2 }, server: { requiredSchemaVersion: 3 }, network: { tcpConnected: true } }, null, 2),
    'history.log': '2026-09-01 ERROR storage_full 导入失败；仅历史，非当前采集。\n',
  },
  repair: {
    'normalize-tags.mjs': 'export function normalizeTags(input) {\n  return input.map(tag => tag.trim()).filter(Boolean)\n}\n',
    'normalize-tags.test.mjs': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { normalizeTags } from './normalize-tags.mjs'\ntest('去空白与空项', () => assert.deepEqual(normalizeTags([' a ', '', '  ', 'b']), ['a', 'b']))\ntest('大小写不敏感去重并保留首次拼写', () => assert.deepEqual(normalizeTags([' Foo ', 'foo', 'BAR', 'bar']), ['Foo', 'BAR']))\ntest('忽略非字符串', () => assert.deepEqual(normalizeTags([null, ' x ', 3, {}]), ['x']))\ntest('非数组返回空数组', () => assert.deepEqual(normalizeTags(null), []))\n",
    'preserve.txt': '此文件与修复无关，不应修改。\n',
  },
  artifact: { 'metrics.json': JSON.stringify(metrics, null, 2) },
}

if (action === 'prepare') {
  // 不覆盖已有目录，避免误删前一次运行的证据与产物。
  mkdirSync(root)
  for (let repeat = 1; repeat <= 3; repeat++) for (const mode of ['standard', 'fast']) for (const [kind, files] of Object.entries(fixtures)) {
    const dir = join(root, `${kind}-${mode}-${repeat}`)
    mkdirSync(dir)
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  }
  for (const scenario of ['budget-timeout-fast-1', 'budget-custom-fast-1', 'budget-dismiss-fast-1', 'budget-dismiss-fast-2']) {
    const dir = join(root, scenario)
    mkdirSync(dir)
    const names = ['start.txt', ...Array.from({ length: 15 }, () => randomBytes(6).toString('hex') + '.txt')]
    for (let i = 0; i < names.length; i++) writeFileSync(join(dir, names[i]), i + 1 < names.length ? `next=${names[i + 1]}\n` : 'final=EVIDENCE-END-731\n')
  }
  writeFileSync(join(root, 'README.md'), 'DSH 快速模式桌面对照测试。各子目录为独立固定材料；仅在指定子目录执行任务。\n')
  console.log('材料已准备：' + root)
} else {
  const results = []
  const expected = { totalRequests: 300, totalErrors: 10, errorRate: 0.0333, services: [{ service: 'api', errorRate: 0.05 }, { service: 'web', errorRate: 0 }, { service: 'worker', errorRate: 0 }] }
  for (const mode of ['standard', 'fast']) for (let repeat = 1; repeat <= 3; repeat++) {
    // 只读任务的全部材料必须保持原样。
    for (const kind of ['query', 'diagnosis']) for (const [name, content] of Object.entries(fixtures[kind])) assert.equal(readFileSync(join(root, `${kind}-${mode}-${repeat}`, name), 'utf8'), content)
    const repair = join(root, `repair-${mode}-${repeat}`)
    const { normalizeTags: normalize } = await import(pathToFileURL(join(repair, 'normalize-tags.mjs')))
    const checks = [
      () => assert.deepEqual(normalize(undefined), []),
      () => assert.deepEqual(normalize('abc'), []),
      () => assert.deepEqual(normalize({}), []),
      () => assert.deepEqual(normalize([null, 3, false, {}, ['x'], ' a ']), ['a']),
      () => assert.deepEqual(normalize([' Foo ', 'foo', 'BAR', 'bar', ' Foo', 'Baz']), ['Foo', 'BAR', 'Baz']),
      () => assert.deepEqual(normalize(['__proto__', 'toString', 'TOSTRING', '__PROTO__']), ['__proto__', 'toString']),
      () => assert.deepEqual(normalize(['  ', '\n', '\t']), []),
      () => { const input = Object.freeze([' A ', 'a', 'B']); assert.deepEqual(normalize(input), ['A', 'B']); assert.deepEqual(input, [' A ', 'a', 'B']) },
      () => assert.equal(readFileSync(join(repair, 'preserve.txt'), 'utf8'), fixtures.repair['preserve.txt']),
      () => assert.equal(readFileSync(join(repair, 'normalize-tags.test.mjs'), 'utf8'), fixtures.repair['normalize-tags.test.mjs']),
      () => assert.deepEqual(readdirSync(repair).sort(), Object.keys(fixtures.repair).sort()),
    ]
    checks.forEach(check => check())
    const testOutput = execFileSync(process.execPath, ['--test', join(repair, 'normalize-tags.test.mjs')], { cwd: repair, encoding: 'utf8', timeout: 5000 })
    assert.match(testOutput, /(?:#|ℹ) pass 4/)
    results.push({ id: `repair-${mode}-${repeat}`, independentChecks: checks.length, existingTests: 4, passed: true })
    const artifact = join(root, `artifact-${mode}-${repeat}`)
    // 先检查模型确实生成了报告，再重跑脚本；不能由验收器替模型补交付。
    assert.equal(existsSync(join(artifact, 'report.json')), true)
    assert.deepEqual(JSON.parse(readFileSync(join(artifact, 'report.json'), 'utf8')), expected)
    assert.equal(readFileSync(join(artifact, 'metrics.json'), 'utf8'), fixtures.artifact['metrics.json'])
    for (const cwd of ['/', '/tmp']) {
      execFileSync(process.execPath, [join(artifact, 'report.mjs')], { cwd, timeout: 5000 })
      assert.deepEqual(JSON.parse(readFileSync(join(artifact, 'report.json'), 'utf8')), expected)
    }
    assert.equal(readFileSync(join(artifact, 'metrics.json'), 'utf8'), fixtures.artifact['metrics.json'])
    assert.deepEqual(readdirSync(artifact).sort(), ['metrics.json', 'report.json', 'report.mjs'])
    results.push({ id: `artifact-${mode}-${repeat}`, passed: true })
  }
  console.log(JSON.stringify({ root, readOnlyFixturesUnchanged: true, results }, null, 2))
}
