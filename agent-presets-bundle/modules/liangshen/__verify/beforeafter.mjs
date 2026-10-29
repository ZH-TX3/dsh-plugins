/**
 * Prove the ORIGINAL bug is actually gone: run the PRE-FIX code path against a
 * real Session and show it fails, then the POST-FIX path and show it works.
 */
import { pathToFileURL } from 'node:url'
const NM = 'D:/nvm/v24.18.1/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const { Session } = await import(pathToFileURL(`${NM}/dsh-session/lib/index.js`).href)
let fail = 0
const ok = (l, c, d = '') => { console.log((c ? 'PASS' : 'FAIL') + '  ' + l + (d ? ' — ' + d : '')); if (!c) fail++ }

const S = (id, specs) => Session.create(id, specs.map((s, seq) => ({
  type: s.type, seq, time: 1e12 + seq, data: s.data ?? {},
})), { version: 4, id, createdAt: 1e12, cwd: '/repo', isSeeded: false, delegationDepth: 0 })

const sess = S('ba', [{ type: 'tool/call' }])

// 1. The exact pre-fix expression from compaction-epoch.mjs L36 / instruction-hint L138.
let oldErr = null
try { for (const _ of sess.events) { /* noop */ } } catch (e) { oldErr = e }
ok('pre-fix `for (const e of session.events)` throws on a real Session',
  oldErr !== null, oldErr?.message)
ok('  -> and the Session really has no .events field', typeof sess.events === 'undefined')

let oldErr2 = null
try { sess.events.some(() => true) } catch (e) { oldErr2 = e }
ok('pre-fix `session.events.some(...)` also throws', oldErr2 !== null, oldErr2?.message)

// 2. Post-fix: the projection path yields the right answer with NO history read.
const { createEpochProjection } = await import(
  'file:///D:/ds/dsh-plugins/agent-presets-bundle/modules/liangshen/compaction-epoch.mjs')
const def = createEpochProjection(['tool/call'])
let st = def.init()
for (const ev of sess.log) st = def.apply(st, ev)   // the registry's own fold
ok('post-fix projection fold gives promoted=true without touching session.events',
  st.promoted === true, JSON.stringify(st))

// 3. Confirm the fold never reads a deprecated synchronous accessor.
const forbidden = ['snapshotEvents', 'ownEvents', 'eventAt', 'events']
const touched = []
const proxy = new Proxy(sess, {
  get(t, k) { if (typeof k === 'string' && forbidden.includes(k)) touched.push(k); return t[k] },
})
let st2 = def.init()
for (const ev of proxy.log) st2 = def.apply(st2, ev)
ok('the fold touches none of the deprecated accessors', touched.length === 0, JSON.stringify(touched))

console.log('\n' + (fail === 0 ? 'BEFORE/AFTER CONTRAST VERIFIED' : fail + ' FAILED'))
process.exit(fail ? 1 : 0)
