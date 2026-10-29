/** Reconstruct the anchored/promoted timeline from real logs to confirm 6.3. */
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
const B = new URL('..', import.meta.url).href.replace(/\/$/, '')
const SESSIONS = (process.env.DSH_HOME ?? join(homedir(), '.dsh')) + '/sessions'
import { homedir } from 'node:os'
import { join } from 'node:path'

const { createEpochProjection } = await import(`${B}/compaction-epoch.mjs`)
const def = createEpochProjection(['tool/call'])

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

const rows = []
for (const f of walk(SESSIONS)) {
  let evs; try { evs = decode(f) } catch { continue }
  const h = evs.find(e => e.type === 'session'); if (!h) continue
  const reqs = evs.filter(e => e.type === 'request/header')
  const first = (reqs[0]?.data?.header?.tools ?? []).length
  if (first === 0) continue
  const ts = h.createdAt
  if (typeof ts !== 'number') continue
  let st = def.init(); for (const ev of evs) st = def.apply(st, ev)
  rows.push({ t: ts, preset: h.agentPreset ?? '(none)', first, promoted: st.promoted, id: h.id })
}
rows.sort((a, b) => a.t - b.t)
console.log('date        preset            firstReqTools  anchored?  promotedAfterFold')
for (const r of rows) {
  const d = new Date(r.t).toISOString().slice(0, 10)
  const anchored = r.first <= 3
  console.log(`${d}  ${String(r.preset).padEnd(16)}  ${String(r.first).padStart(2)}             ${anchored ? 'YES' : 'no '}        ${r.promoted}`)
}
const anchoredRows = rows.filter(r => r.first <= 3)
console.log(`\n${anchoredRows.length}/${rows.length} sessions show an anchored first request (<=3 tools)`)
if (anchoredRows.length) {
  console.log('anchored date range:', new Date(anchoredRows[0].t).toISOString().slice(0,10),
              '..', new Date(anchoredRows.at(-1).t).toISOString().slice(0,10))
}
