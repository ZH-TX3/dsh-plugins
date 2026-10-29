/**
 * Verification against the REAL components:
 *   - real `cordis.Context` (not a hand-written stub)
 *   - real `SessionProjectionRegistry` from dsh-session-projection
 *   - real `Session` from dsh-session
 *   - real plugin `apply()` functions from the bundle
 */
import { pathToFileURL } from 'node:url'
const NM = 'D:/nvm/v24.18.1/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const { Context } = await import(pathToFileURL(`${NM}/cordis/lib/index.js`).href)
const { default: SessionProjectionRegistry } =
  await import(pathToFileURL(`${NM}/dsh-session-projection/lib/index.js`).href)
const { Session } = await import(pathToFileURL(`${NM}/dsh-session/lib/index.js`).href)
const B = 'file:///D:/ds/dsh-plugins/agent-presets-bundle/modules/liangshen'
const { apply: applyBootstrap } = await import(`${B}/tool-bootstrap.mjs`)
const { apply: applyHint } = await import(`${B}/instruction-hint.mjs`)
const { epochProjectionKey } = await import(`${B}/compaction-epoch.mjs`)

let fail = 0
const ok = (l, c, d = '') => { console.log((c ? 'PASS' : 'FAIL') + '  ' + l + (d ? ' — ' + d : '')); if (!c) fail++ }

/** Boot a real Cordis root ctx + real projection registry. */
async function boot() {
  const ctx = new Context()
  await new Promise((r) => setTimeout(r, 10))
  new SessionProjectionRegistry(ctx)
  await new Promise((r) => setTimeout(r, 20))
  return ctx
}

/** Real Session with a contiguous seed. */
const S = (id, specs, depth = 0) => Session.create(
  id,
  specs.map((s, seq) => ({
    type: s.type, seq, time: 1e12 + seq,
    ...(s.type === 'user/message' || s.type === 'developer/message' ? { surfaceOp: 'append' } : {}),
    data: s.data ?? {},
  })),
  { version: 4, id, createdAt: 1e12, cwd: '/repo', isSeeded: false, delegationDepth: depth },
)

const CAT = ['bash', 'str_replace_editor', 'read', 'write', 'web_search', 'todo_write', 'subagent']
  .map((name) => ({ name }))

// ── 1. the real registry is reachable through the real Cordis ctx ──────────
{
  const ctx = await boot()
  const reg = ctx.get('sessionProjections')
  ok('real ctx.get("sessionProjections") returns the real registry', reg !== undefined)
  ok('  -> it is a SessionProjectionRegistry', reg?.constructor?.name === 'SessionProjectionRegistry',
    reg?.constructor?.name)
  ok('  -> register/stateOf exist', typeof reg?.register === 'function' && typeof reg?.stateOf === 'function')
}

// ── 2. our projection registers into the REAL registry and folds correctly ─
{
  const ctx = await boot()
  const reg = ctx.get('sessionProjections')
  const { createEpochProjection } = await import(`${B}/compaction-epoch.mjs`)
  const def = createEpochProjection(['tool/call'])
  const dispose = reg.register(def)

  const cold = S('rc1', [])
  ok('real registry: cold session is unpromoted',
    reg.stateOf(cold, def.key)?.promoted === false,
    JSON.stringify(reg.stateOf(cold, def.key)))

  const warm = S('rc2', [{ type: 'tool/call' }])
  ok('real registry: tool/call promotes', reg.stateOf(warm, def.key)?.promoted === true)

  const re = S('rc3', [{ type: 'tool/call' }, { type: 'compaction/end' }])
  const st = reg.stateOf(re, def.key)
  ok('real registry: compaction re-anchors', st?.promoted === false && st?.boundary === 1, JSON.stringify(st))

  dispose()
  ok('dispose() removes the unit from the real registry',
    reg.stateOf(S('rc4', []), def.key) === undefined)
}

// ── 3. the key-collision fix verified on the REAL registry ────────────────
{
  const ctx = await boot()
  const reg = ctx.get('sessionProjections')
  const { createEpochProjection } = await import(`${B}/compaction-epoch.mjs`)

  const dTool = createEpochProjection(['tool/call'])
  const dEither = createEpochProjection(['tool/call', 'assistant/message'])
  ok('two different promoteOn sets get different keys', dTool.key !== dEither.key,
    `${dTool.key} vs ${dEither.key}`)

  reg.register(dTool)
  reg.register(dEither)

  // A message-only event must promote ONLY the `either` unit.
  const sess = S('mix1', [{
    type: 'developer/message',
    data: { message: { id: 'd1', role: 'developer', content: [{ type: 'text', text: 'x' }],
      source: { kind: 'runtime-context', form: 'snapshot' } } },
  }])
  const a = reg.stateOf(sess, dTool.key)
  const b = reg.stateOf(sess, dEither.key)
  ok('on the REAL registry: tool-call unit stays unpromoted', a?.promoted === false, JSON.stringify(a))
  ok('on the REAL registry: either unit is unpromoted too (no promotion event)',
    b?.promoted === false, JSON.stringify(b))

  // Now with an actual assistant/message settlement shape.
  const sess2 = S('mix2', [])
  // Drive the registry the way the runtime does: emit session/event.
  ctx.emit('session/event', sess2, {
    type: 'assistant/message', seq: 0, time: 1e12,
    data: { turn: 0, step: 0, stream: 'main',
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'model', provider: 'p', model: 'm' } } },
  })
  const a2 = reg.stateOf(sess2, dTool.key)
  const b2 = reg.stateOf(sess2, dEither.key)
  ok('after assistant/message: tool-call unit still unpromoted', a2?.promoted === false, JSON.stringify(a2))
  ok('after assistant/message: either unit promoted', b2?.promoted === true, JSON.stringify(b2))
}

// ── 4. real plugin apply() against the real registry ──────────────────────
{
  const ctx = await boot()
  const reg = ctx.get('sessionProjections')

  // A faithful "agent" the listeners accept.
  const mkAgent = (session) => ({ session, options: {} })

  // system-prompt/assemble through the real ctx event bus.
  const assemble = async (session) => {
    const assembled = { sections: [], contexts: [], tools: CAT, variables: {} }
    return ctx.waterfall('system-prompt/assemble', assembled,
      { agent: mkAgent(session), scope: mkAgent(session) }, (a) => a)
  }

  // NOTE: cordis waterfall here is driven synchronously via emit's next callback.
  applyBootstrap(ctx, { bootstrapTools: ['bash', 'str_replace_editor'], promoteOn: 'tool-call' })
  await new Promise((r) => setTimeout(r, 30))   // let ctx.inject attach

  const cold = await assemble(S('p1', []))
  ok('real registry + real plugin: cold session narrowed to 2',
    cold?.tools?.length === 2, JSON.stringify(cold?.tools?.map(t => t.name)))
}

console.log('\n' + (fail === 0 ? 'ALL REAL-COMPONENT PROBES PASSED' : fail + ' FAILED'))
process.exit(fail ? 1 : 0)
