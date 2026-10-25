/** 使用已安装的 DSH 运行隔离的真实工具流水线；不连接模型供应商或业务设备。 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const workspace = dirname(fileURLToPath(import.meta.url))
const cli = realpathSync(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
const require = createRequire(join(dirname(dirname(cli)), 'package.json'))
const YAML = require('yaml')
const moduleUrl = name => pathToFileURL(require.resolve(name)).href
const temp = mkdtempSync(join(tmpdir(), 'dsh-budget-integration-'))
const fixture = join(temp, 'fixture.mjs')
writeFileSync(fixture, `
import { appendFileSync } from 'node:fs';
import { LlmAdapter } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-llm'))};
import { defineTool } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-tools'))};
import { apply as tuning } from ${JSON.stringify(pathToFileURL(join(workspace, 'fast-tuning.mjs')).href)};
const scenario = JSON.parse(process.env.BUDGET_CASE);
const record = row => appendFileSync(process.env.BUDGET_TRACE, JSON.stringify(row)+'\\n');
class Adapter extends LlmAdapter {
  count=0;
  async resolveModel(provider,id) { return {provider,id,name:id,reasoning:{efforts:[{id:'low',name:'Low'}]}}; }
  async *stream(options) {
    this.count++;
    const tools=(options.tools||[]).map(t=>t.name);
    record({kind:'request', tools, index:this.count});
    const wantsTool = (tools.length>0 && this.count <= (scenario.modelToolRounds ?? (scenario.full ? 6 : 20))) || scenario.rogue;
    if(wantsTool) {
      for(let i=0;i<(scenario.batch||1);i++) {
        const name=scenario.unknown?'nonexistent':scenario.shell?'bash':'inspect';
        const args=scenario.shell?{description:'验证本地任务执行',command:'sleep 2',...(scenario.background?{run_in_background:true}:{})}:{};
        yield {type:'block-start',index:i,blockType:'tool-call'};
        yield {type:'block-end',index:i,block:{type:'tool-call',id:'call_'+this.count+'_'+i,name,arguments:JSON.stringify(args)}};
      }
      yield {type:'finish',reason:{kind:'tool-calls'}};
    } else {
      yield {type:'block-start',index:0,blockType:'text'};
      yield {type:'block-end',index:0,block:{type:'text',text:'已确认：仅完成有限取证。未确认：深层原因尚未验证。是否继续深入调查？'}};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
}
export const inject=['llm','tools'];
export function apply(ctx) {
  ctx.llm.registerAdapter(['budget-test'],new Adapter());
  tuning({agentPresets:{composedPreset:()=>scenario.full?'fast-full':'fast'},tools:ctx.tools,on:ctx.on.bind(ctx)},scenario.config||{});
  ctx.on('tools/execute',async(exec,next)=>{
    record({kind:'dispatch',name:exec.name});
    try{return await next()}finally{record({kind:'dispatch-end',name:exec.name,aborted:exec.signal.aborted})}
  });
  ctx.tools.register(defineTool({name:'inspect',description:'返回固定模拟材料',parameters:{},isConcurrencySafe:()=>true,output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async(_args,exec)=>{
    record({kind:'body',name:'inspect'});
    if(scenario.slow) await new Promise((resolve,reject)=>{
      const timer=setTimeout(resolve,2000);
      exec.signal.addEventListener('abort',()=>{clearTimeout(timer);record({kind:'cancelled'});reject(new Error('fixture cancelled'))},{once:true});
    });
    return '模拟材料已取得；深层原因未验证。';
  }}));
}
`)
const disabled = ['tool-plugin-manager', 'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'agent-instructions', 'skill', 'skill-filesystem', 'skill-badge', 'tool-skill', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-todo', 'tool-goal', 'tool-ralph', 'tool-web', 'mcp-resources', 'session-title-llm']
const cases = [
  { id: 'default-round-cap', bodies: 10 },
  { id: 'parallel-call-cap', batch: 12, config: { maxToolCalls: 3 }, bodies: 3 },
  { id: 'unknown-tool-cap', unknown: true, config: { maxToolRounds: 2 }, bodies: 0 },
  { id: 'cooperative-timeout', slow: true, config: { toolTimeoutMs: 20 }, bodies: 1 },
  { id: 'shell-cancellation', shell: true, config: { toolTimeoutMs: 100 }, bodies: 1 },
  { id: 'shell-background', shell: true, background: true, config: { maxToolCalls: 1 }, bodies: 1 },
  { id: 'full-mode', full: true, config: { maxToolRounds: 1, maxToolCalls: 1 }, bodies: 6 },
  { id: 'authorized-request', task: '开始实施并完成必要验证', modelToolRounds: 6, config: { maxToolRounds: 1, maxToolCalls: 1 }, bodies: 6 },
  { id: 'quoted-request', task: '请分析这段引用：“开始实施并完成必要验证”', config: { maxToolRounds: 1 }, bodies: 1 },
  { id: 'confirmation', confirm: true, modelToolRounds: 6, config: { maxToolRounds: 1, maxToolCalls: 1 }, bodies: 1 },
  { id: 'rogue-final-call', rogue: true, config: { maxToolRounds: 1 }, bodies: 1 },
]
const runs = []
for (const scenario of cases) {
  const patch = join(temp, scenario.id + '.yml')
  writeFileSync(patch, YAML.stringify([
    ...disabled.filter(id => !(scenario.shell && id === 'tool-bash') && !(scenario.background && id === 'tool-jobs')).map(id => ({ id, disabled: true })),
    ...(scenario.shell ? [{ id: 'tool-bash', config: { promoteOnTimeout: false } }] : []),
    { id: 'agent-default-model', config: { provider: 'budget-test', model: 'fixture' } },
    { insert: [{ id: 'fixture', name: fixture }] },
  ]))
  const trace = join(temp, scenario.id + '-trace.jsonl')
  const started = Date.now()
  const result = spawnSync(process.execPath, [cli, '--profile', 'headless', '--patch', patch, '--json', scenario.task ?? '读取必要材料后给出已确认结果，未知部分列为疑点。'], {
    cwd: temp, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, DSH_HOME: join(temp, 'home-' + scenario.id), BUDGET_CASE: JSON.stringify(scenario), BUDGET_TRACE: trace },
  })
  writeFileSync(join(temp, scenario.id + '-events.jsonl'), result.stdout || '')
  writeFileSync(join(temp, scenario.id + '-stderr.log'), result.stderr || '')
  // DSH 将被预算兜底终止的回合标为 blocked，CLI 因而返回 1；仍须存在明确回答。
  assert.equal(result.status, scenario.rogue ? 1 : 0, `${scenario.id}: ${result.error || result.stderr?.slice(-1500)}`)
  const events = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const records = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const requests = records.filter(row => row.kind === 'request')
  const bodies = records.filter(row => scenario.shell ? row.kind === 'dispatch' && row.name === 'bash' : row.kind === 'body').length
  assert.equal(bodies, scenario.bodies, scenario.id + ' 实际工具执行次数')
  if (!scenario.full && scenario.id !== 'authorized-request') assert.equal(requests.at(-1).tools.length, 0, scenario.id + ' 最终请求仍包含工具')
  if (scenario.unknown) assert.equal(requests.length, 3)
  if (scenario.slow) assert.ok(records.some(row => row.kind === 'cancelled'))
  if (scenario.shell && !scenario.background) assert.ok(records.some(row => row.kind === 'dispatch-end' && row.name === 'bash' && row.aborted), '命令未收到取消')
  if (scenario.background) {
    const results = events.filter(row => row.type === 'tool_result')
    assert.ok(results.some(row => row.status === 'completed' && /background job/i.test(row.result)), '后台任务未成功返回作业信息')
  }
  const final = events.findLast(row => row.type === 'final')?.text
  assert.ok(final, scenario.id + ' 未交付回答')
  if (scenario.rogue) assert.match(final, /模型未能完成最终回答/)
  else assert.match(final, /已确认/)
  const row = { id: scenario.id, toolBodies: bodies, modelRequests: requests.length, requestToolCounts: requests.map(row => row.tools.length), elapsedMs: Date.now() - started, passed: true }
  runs.push(row)
  console.log(JSON.stringify(row))
  if (scenario.confirm) {
    const sessionId = events.find(row => row.type === 'session').sessionId
    for (const [id, task, expectedBodies] of [['confirmed-continuation', '好', 6], ['authorization-revoked', '恢复预算限制，只看现有材料', 1]]) {
      const nextTrace = join(temp, id + '-trace.jsonl')
      const resumed = spawnSync(process.execPath, [cli, '--profile', 'headless', '--patch', patch, '--session-id', sessionId, '--json', task], {
        cwd: temp, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, DSH_HOME: join(temp, 'home-' + scenario.id), BUDGET_CASE: JSON.stringify(scenario), BUDGET_TRACE: nextTrace },
      })
      writeFileSync(join(temp, id + '-events.jsonl'), resumed.stdout || '')
      writeFileSync(join(temp, id + '-stderr.log'), resumed.stderr || '')
      assert.equal(resumed.status, 0, id + ': ' + resumed.stderr)
      const nextRecords = readFileSync(nextTrace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const nextRequests = nextRecords.filter(row => row.kind === 'request')
      const nextBodies = nextRecords.filter(row => row.kind === 'body').length
      assert.equal(nextBodies, expectedBodies, id)
      assert.equal(nextRequests.at(-1).tools.length === 0, id === 'authorization-revoked')
      const nextRow = { id, toolBodies: nextBodies, modelRequests: nextRequests.length, requestToolCounts: nextRequests.map(row => row.tools.length), passed: true }
      runs.push(nextRow)
      console.log(JSON.stringify(nextRow))
    }
  }
}
const report = { date: '2026-10-25', method: 'DSH headless 真实组装、工具调度与执行 guard；确定性测试适配器，不调用供应商或真实设备。预设服务使用替身。', cliVersion: JSON.parse(readFileSync(join(dirname(dirname(cli)), 'package.json'), 'utf8')).version, runs }
if (process.argv[2]) writeFileSync(resolve(process.argv[2]), JSON.stringify(report, null, 2) + '\n')
console.log('隔离集成检查通过，原始材料目录：' + temp)
