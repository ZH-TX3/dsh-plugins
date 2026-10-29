/**
 * The decisive test: take a REAL liangshen session from 2026-10-19 (where the
 * first request wrongly carried 46 tools) and ask the FIXED plugin what it
 * would decide for that same session at its first request.
 *
 * If the fix works, a cold session must be judged "not promoted" -> 2 tools.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
const SESSIONS = (process.env.DSH_HOME ?? join(homedir(), '.dsh')) + '/sessions'
import { homedir } from 'node:os'

const NM = process.env.DSH_AI_BASE ??
  join(dirname(process.execPath), 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
const { Context } = await import(pathToFileURL(`${NM}/cordis/lib/index.js`).href)
const { default: Registry } = await import(pathToFileURL(`${NM}/dsh-session-projection/lib/index.js`).href)
const { Session } = await import(pathToFileURL(`${NM}/dsh-session/lib/index.js`).href)
const B = new URL('..', import.meta.url).href.replace(/\/$/, '')
const { apply: applyBootstrap } = await import(`${B}/tool-bootstrap.mjs`)

const tick = (ms = 25) => new Promise(r => setTimeout(r, ms))
function walk(d, o = []) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = d + '/' + e.name
  if (e.isDirectory()) walk(p, o); else if (e.name === 'session.v4.jsonl.zstd') o.push(p) } return o }
function decode(p) {
  const buf = readFileSync(p), M = [0x28,0xb5,0x2f,0xfd], st = []
  for (let i = 0; i + 4 <= buf.length; i++) if (M.every((x,k)=>buf[i+k]===x)) st.push(i)
  let t = ''
  for (let k = 0; k < st.length; k++) { const s = buf.subarray(st[k], k+1<st.length?st[k+1]:buf.length)
    try { t += zstdDecompressSync(s).toString('utf8') } catch {} }
  return t.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean)
}

// Pick one real liangshen session whose first request was NOT anchored.
let target = null
for (const f of walk(SESSIONS)) {
  let evs; try { evs = decode(f) } catch { continue }
  const h = evs.find(e => e.type === 'session'); if (!h) continue
  if (h.agentPreset !== 'liangshen') continue
  const reqs = evs.filter(e => e.type === 'request/header')
  const first = (reqs[0]?.data?.header?.tools ?? []).length
  if (first > 10) { target = { evs, h, first }; break }
}
if (!target) { console.log('no suitable real session found'); process.exit(1) }

console.log(`real session ${target.h.id}`)
console.log(`  created      : ${new Date(target.h.createdAt).toISOString()}`)
console.log(`  preset       : ${target.h.agentPreset}`)
console.log(`  ACTUAL first request carried ${target.first} tools  <- the bug`)

// Rebuild a Session whose log stops just BEFORE the first request/header,
// i.e. exactly the state the plugin sees when assembling that first request.
const cut = target.evs.findIndex(e => e.type === 'request/header')
const pre = target.evs.slice(0, cut).filter(e => typeof e.seq === 'number')
const seed = pre.map(e => ({
  type: e.type, seq: e.seq, time: e.time ?? 1e12,
  ...(e.surfaceOp ? { surfaceOp: e.surfaceOp } : {}),
  ...(e.data ? { data: e.data } : {}),
})).sort((a, b) => a.seq - b.seq)
// Session requires a contiguous 0-based seed; renumber if needed.
seed.forEach((e, i) => { e.seq = i })

const sess = Session.create('replay', seed,
  { version: 4, id: 'replay', createdAt: target.h.createdAt, cwd: 'C:/x', isSeeded: false, delegationDepth: 0 })

const ctx = new Context(); await tick(10); new Registry(ctx); await tick(20)
applyBootstrap(ctx, { bootstrapTools: ['bash', 'str_replace_editor'], promoteOn: 'tool-call' })
await tick(40)

const CAT = ['bash','str_replace_editor','read','write','web_search','todo_write','subagent'].map(name=>({name}))
const agent = { session: sess, options: {} }
const out = await ctx.waterfall('system-prompt/assemble',
  { sections: [], contexts: [], tools: CAT, variables: {} }, { agent, scope: agent }, a => a)

const names = out.tools.map(t => t.name)
console.log(`\nFIXED plugin on that same session state -> ${names.length} tools: ${JSON.stringify(names)}`)
const good = names.length === 2
console.log(good
  ? 'PASS: the fix restores anchoring on a real 2026-10-19 session (46 -> 2)'
  : 'FAIL: still not anchored')
process.exit(good ? 0 : 1)
