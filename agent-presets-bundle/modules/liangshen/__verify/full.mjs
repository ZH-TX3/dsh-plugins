/** Full behavioural regression on REAL cordis + REAL registry + REAL Session. */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const NM = process.env.DSH_AI_BASE ??
  join(dirname(process.execPath), 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
const { Context, Service } = await import(pathToFileURL(`${NM}/cordis/lib/index.js`).href)
const { default: Registry } = await import(pathToFileURL(`${NM}/dsh-session-projection/lib/index.js`).href)
const { Session } = await import(pathToFileURL(`${NM}/dsh-session/lib/index.js`).href)
const B = new URL('..', import.meta.url).href.replace(/\/$/, '')
const { apply: applyBootstrap } = await import(`${B}/tool-bootstrap.mjs`)
const { apply: applyHint } = await import(`${B}/instruction-hint.mjs`)

let fail = 0
const ok = (l, c, d = '') => { console.log((c ? 'PASS' : 'FAIL') + '  ' + l + (d ? ' — ' + d : '')); if (!c) fail++ }
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms))

async function boot(extra = {}) {
  const ctx = new Context()
  await tick(10)
  new Registry(ctx)
  await tick(20)
  // Minimal fs service the hint plugin resolves through ctx.get('fs').
  if (extra.fs) {
    class FsService extends Service {
      constructor(c) { super(c, "fs"); Object.assign(this, extra.fs) }
    }
    new FsService(ctx)
    await tick(15)
  }
  return ctx
}
const S = (id, specs, depth = 0) => Session.create(id, specs.map((s, seq) => ({
  type: s.type, seq, time: 1e12 + seq,
  ...(s.type === 'user/message' || s.type === 'developer/message' ? { surfaceOp: 'append' } : {}),
  data: s.data ?? {},
})), { version: 4, id, createdAt: 1e12, cwd: '/repo', isSeeded: false, delegationDepth: depth })
const CAT = ['bash', 'str_replace_editor', 'read', 'write', 'web_search', 'todo_write', 'subagent'].map(name => ({ name }))
const agentOf = (session) => ({ session, options: {} })
const assemble = (ctx, session) => ctx.waterfall('system-prompt/assemble',
  { sections: [], contexts: [], tools: CAT, variables: {} },
  { agent: agentOf(session), scope: agentOf(session) }, (a) => a)

// ── tool-bootstrap lifecycle on the real stack ──
{
  const ctx = await boot()
  applyBootstrap(ctx, { bootstrapTools: ['bash', 'str_replace_editor'], promoteOn: 'tool-call' })
  await tick(40)

  const cold = await assemble(ctx, S('f1', []))
  ok('cold real session -> 2 tools', cold.tools.length === 2, JSON.stringify(cold.tools.map(t => t.name)))

  const warm = await assemble(ctx, S('f2', [{ type: 'tool/call' }]))
  ok('after real tool/call -> full catalog', warm.tools.length === 7, String(warm.tools.length))

  const re = await assemble(ctx, S('f3', [{ type: 'tool/call' }, { type: 'compaction/end' }]))
  ok('after real compaction -> re-anchored to 2', re.tools.length === 2, String(re.tools.length))

  // Subagent default: treated as already promoted.
  const sub = await assemble(ctx, S('f4', [], 1))
  ok('subagent (delegationDepth 1) keeps the full catalog by default', sub.tools.length === 7, String(sub.tools.length))
}

// ── instruction-hint lifecycle on the real stack ──
{
  const fs = {
    async resolve(p) { return { path: p } },
    async stat(t) { return t.path.endsWith('AGENTS.md') ? { type: 'file' } : undefined },
    async readTextFile() { return '' },
  }
  const ctx = await boot({ fs })
  applyHint(ctx, {})
  await tick(40)
  const preStep = (session) => ctx.waterfall('agent/pre-step',
    { agent: agentOf(session), messages: [], signal: { throwIfAborted() {} } },
    () => ({ kind: 'enter', messages: [] }))

  ok('hint not injected before promotion', (await preStep(S('g1', []))).messages.length === 0)

  const warm = S('g2', [{ type: 'tool/call' }])
  const d = await preStep(warm)
  ok('hint injected after real promotion', d.messages.length === 1, String(d.messages.length))
  ok('  -> source.kind = instruction-hint', d.messages[0]?.source?.kind === 'instruction-hint',
    JSON.stringify(d.messages[0]?.source))

  // Resume: append the durable hint event, boot a FRESH ctx (new plugin instance).
  warm.log.push({ type: 'user/message', seq: warm.log.length, time: 1e12, surfaceOp: 'append',
    data: { id: 'hint-g2', role: 'user', content: [{ type: 'text', text: 'x' }],
      source: { kind: 'instruction-hint', form: 'hint' } } })
  const ctx2 = await boot({ fs })
  applyHint(ctx2, {})
  await tick(40)
  const again = await ctx2.waterfall('agent/pre-step',
    { agent: agentOf(warm), messages: [], signal: { throwIfAborted() {} } },
    () => ({ kind: 'enter', messages: [] }))
  ok('resumed session does not re-fire the hint', again.messages.length === 0, String(again.messages.length))
}

// ── the two hidden traps, on the real stack ──
{
  const ctx = await boot()
  const reg = ctx.get('sessionProjections')
  // Different promoteOn on the SAME real registry must not cross-contaminate.
  applyBootstrap(ctx, { bootstrapTools: ['bash', 'str_replace_editor'], promoteOn: 'tool-call' })
  applyHint(ctx, { promoteOn: 'either' })
  await tick(40)
  const keys = [...reg.registrations.keys()]
  ok('mixed promoteOn registers 2 distinct units on the real registry',
    keys.length === 2, JSON.stringify(keys))
  const cold = await assemble(ctx, S('h1', []))
  ok('bootstrap still narrows correctly with mixed promoteOn', cold.tools.length === 2,
    String(cold.tools.length))
}

console.log('\n' + (fail === 0 ? 'ALL FULL REAL-STACK PROBES PASSED' : fail + ' FAILED'))
process.exit(fail ? 1 : 0)
