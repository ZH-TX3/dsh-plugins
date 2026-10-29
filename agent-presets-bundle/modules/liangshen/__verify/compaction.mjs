/** Compaction re-anchoring on the real stack (synthetic log: compaction is hard to replay). */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const NM = process.env.DSH_AI_BASE ??
  join(dirname(process.execPath), 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
const { Context } = await import(pathToFileURL(`${NM}/cordis/lib/index.js`).href)
const { default: Registry } = await import(pathToFileURL(`${NM}/dsh-session-projection/lib/index.js`).href)
const { Session } = await import(pathToFileURL(`${NM}/dsh-session/lib/index.js`).href)
const B = new URL('..', import.meta.url).href.replace(/\/$/, '')
const { apply: applyBootstrap } = await import(`${B}/tool-bootstrap.mjs`)
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms))
let fail = 0
const ok = (l,c,d='') => { console.log((c?'PASS':'FAIL')+'  '+l+(d?' — '+d:'')); if(!c) fail++ }

const S = (id, specs) => Session.create(id, specs.map((s, seq) => ({
  type: s.type, seq, time: 1e12 + seq, data: s.data ?? {} })),
  { version: 4, id, createdAt: 1e12, cwd: '/repo', isSeeded: false, delegationDepth: 0 })
const CAT = ['bash','str_replace_editor','read','write','web_search','todo_write','subagent'].map(name=>({name}))

async function surface(session) {
  const ctx = new Context(); await tick(8); new Registry(ctx); await tick(15)
  applyBootstrap(ctx, { bootstrapTools: ['bash','str_replace_editor'], promoteOn: 'tool-call' })
  await tick(30)
  const agent = { session, options: {} }
  const out = await ctx.waterfall('system-prompt/assemble',
    { sections: [], contexts: [], tools: CAT, variables: {} }, { agent, scope: agent }, a => a)
  return out.tools.map(t => t.name)
}

ok('cold -> 2', (await surface(S('c1', []))).length === 2)
ok('tool/call -> 7', (await surface(S('c2', [{type:'tool/call'}]))).length === 7)
const re = await surface(S('c3', [{type:'tool/call'},{type:'compaction/end'}]))
ok('compaction re-anchors -> 2', re.length === 2, JSON.stringify(re))
ok('post-compaction new tool/call -> 7',
   (await surface(S('c4', [{type:'tool/call'},{type:'compaction/end'},{type:'tool/call'}]))).length === 7)
ok('two compactions -> still anchored at the last boundary',
   (await surface(S('c5', [{type:'tool/call'},{type:'compaction/end'},{type:'tool/call'},{type:'compaction/end'}]))).length === 2)

// compactionTools: a recovery catalog exposed right after compaction
{
  const ctx = new Context(); await tick(8); new Registry(ctx); await tick(15)
  applyBootstrap(ctx, { bootstrapTools:['bash','str_replace_editor'], promoteOn:'tool-call', compactionTools:['bash','read'] })
  await tick(30)
  const agent = { session: S('c6', [{type:'tool/call'},{type:'compaction/end'}]), options: {} }
  const out = await ctx.waterfall('system-prompt/assemble',
    { sections: [], contexts: [], tools: CAT, variables: {} }, { agent, scope: agent }, a => a)
  // compactionTools is ADDITIVE: it extends the bootstrap pair, it does not replace it.
  ok('compactionTools extends the bootstrap pair (additive, per source)',
     JSON.stringify(out.tools.map(t=>t.name)) === JSON.stringify(['bash','str_replace_editor','read']),
     JSON.stringify(out.tools.map(t=>t.name)))
}
console.log('\n' + (fail===0 ? 'COMPACTION PROBES PASSED' : fail+' FAILED'))
process.exit(fail?1:0)
