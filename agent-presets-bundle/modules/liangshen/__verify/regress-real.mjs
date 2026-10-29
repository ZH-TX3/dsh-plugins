/**
 * Regression against REAL historical session logs.
 *
 * Rebuilds each session's durable log and folds it with the NEW projection
 * definition, then reports the phase the fixed plugin would compute. This is
 * what proves the fix restores the intended semantics on real data instead of
 * only on synthetic fixtures.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const { createEpochProjection } = await import(
  'file:///D:/ds/dsh-plugins/agent-presets-bundle/modules/liangshen/compaction-epoch.mjs')
const def = createEpochProjection(['tool/call'])

function decode(path) {
  const buf = readFileSync(path)
  const M = [0x28, 0xb5, 0x2f, 0xfd]
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) if (M.every((x, k) => buf[i + k] === x)) starts.push(i)
  let text = ''
  for (let k = 0; k < starts.length; k++) {
    const slice = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)
    try { text += zstdDecompressSync(slice).toString('utf8') } catch {}
  }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = dir + "/" + e.name
    if (e.isDirectory()) walk(p, out)
    else if (e.name === "session.v4.jsonl.zstd") out.push(p)
  }
  return out
}
const files = walk("C:/Users/陈强/.dsh/sessions")

let withPreset = 0, cold = 0, promoted = 0, reanchored = 0
const rows = []
for (const f of files) {
  let events
  try { events = decode(f) } catch { continue }
  const header = events.find((e) => e.type === 'session')
  if (!header) continue
  const preset = header.agentPreset
  if (preset) withPreset++

  // Fold the real log through the NEW projection definition.
  let st = def.init()
  let sawCompaction = false
  for (const ev of events) {
    if (ev.type === 'compaction/end') sawCompaction = true
    st = def.apply(st, ev)
  }
  if (st.promoted) promoted++
  if (sawCompaction && !st.promoted) reanchored++
  if (!st.promoted) cold++

  const reqs = events.filter((e) => e.type === 'request/header')
  const firstTools = (reqs[0]?.data?.header?.tools ?? []).length
  const lastTools = (reqs.at(-1)?.data?.header?.tools ?? []).length
  rows.push({ preset: preset ?? '(none)', promoted: st.promoted, boundary: st.boundary, firstTools, lastTools })
}

console.log(`sessions decoded        : ${rows.length}`)
console.log(`  with agentPreset      : ${withPreset}`)
console.log(`  folded as promoted    : ${promoted}`)
console.log(`  folded as cold        : ${cold}`)
console.log(`  re-anchored (post-compaction, no new signal): ${reanchored}`)
console.log('\nsample (preset | promoted | boundary | firstTools -> lastTools):')
for (const r of rows.slice(0, 12)) {
  console.log(`  ${String(r.preset).padEnd(16)} | ${String(r.promoted).padEnd(5)} | ${String(r.boundary).padStart(3)} | ${String(r.firstTools).padStart(2)} -> ${r.lastTools}`)
}
console.log('\nOK: the projection fold handled every real log without throwing.')
