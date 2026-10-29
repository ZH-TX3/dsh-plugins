/**
 * Real end-to-end verification: drive a REAL liangshen session with a REAL
 * model, inside the REAL web profile host.
 *
 * Why not `dsh headless`? The one-shot runner rejects preset sessions by
 * design (`dsh-headless` lib/index.js `assertAdoptable`):
 *   session "…" runs under agent preset "…", which the one-shot runner does
 *   not compose
 * So this script boots the web profile through DSH's own `runProfile()` and
 * then uses the exact entry the Web UI uses:
 * `sessionController.agents.ensureSession(id, cwd, isNew, presetId)`.
 *
 * Expected result (see the report, section 6.8):
 *   seq=12 reason=initial tools= 2 ["bash","str_replace_editor"]   <- anchored
 *   seq=22 reason=change  tools=46 [...]                           <- promoted
 *   user sources: user,time-context,instruction-hint,skill-invocation
 *
 * Usage:
 *   node drive-real-session.mjs [workspaceDir] [prompt]
 *
 * Requires WORKBUDDY_API_KEY (the web profile resolves it from
 * ~/.dsh/.credentials.yaml, so a normal DSH install needs nothing extra).
 */
import { pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DSH = process.env.DSH_INSTALL
  ?? 'D:/nvm/v24.18.1/node_modules/@deepseek-ai/dsh'

const { runProfile } = await import(pathToFileURL(`${DSH}/lib/profile-boot.js`).href)
const { loadLayeredEnv } = await import(
  pathToFileURL(`${DSH}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`).href)

// A scratch workspace with an AGENTS.md (so the hint has something to point at)
// and a deliberately wrong calc.py (so the model must actually run a command).
const cwd = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'liangshen-e2e-'))
if (process.argv[2] === undefined) {
  writeFileSync(join(cwd, 'AGENTS.md'), '# AGENTS.md\n本项目用中文回答。\n')
  writeFileSync(join(cwd, 'calc.py'), 'def add(a, b):\n    return a - b\n')
}
const prompt = process.argv[3]
  ?? '先运行 python -c "import calc; print(calc.add(2,3))" 看实际输出，然后告诉我哪里有问题。必须真的运行命令，不要猜。'

const { ctx, shutdown } = await runProfile({
  // MUST be the real loader: a hand-built Map lacks getFrom() and every model
  // request fails with "launchEnvironmentOf(...).getFrom is not a function".
  environment: loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [],
  args: ['--port', '3093', '--no-open'],
})

try {
  const presets = ctx.get('agentPresets')
  console.log('default preset :', presets?.defaultId)

  const sc = ctx.get('sessionController')
  const sessionId = 'liangshen-e2e-' + Date.now()
  const agent = await sc.agents.ensureSession(sessionId, cwd, false, undefined)
  console.log('session        :', sessionId)
  console.log('header preset  :', agent.session.header.agentPreset)
  console.log('projection     :',
    ctx.get('sessionProjections')?.stateOf(agent.session, 'agentPreset'))

  // prompt() takes a second `signal` argument; omitting it throws
  // "Cannot read properties of undefined (reading 'throwIfAborted')".
  await sc.prompt({
    sessionId,
    requestId: 'req-' + Date.now(),
    content: [{ type: 'text', text: prompt }],
  }, new AbortController().signal)
  console.log('prompt accepted, waiting for idle...')

  await agent.whenIdle()
  await new Promise((r) => setTimeout(r, 3000)) // let trailing events settle

  console.log('\n=== request/header trace ===')
  for (const e of agent.session.log.filter((x) => x.type === 'request/header')) {
    const names = (e.data?.header?.tools ?? []).map((t) => t.name)
    console.log(`  seq=${e.seq} reason=${e.data?.reason} tools=${names.length} ${JSON.stringify(names.slice(0, 4))}`)
  }
  console.log('tool/call count:',
    agent.session.log.filter((e) => e.type === 'tool/call').length)
  console.log('user sources   :',
    agent.session.log.filter((e) => e.type === 'user/message')
      .map((e) => e.data?.source?.kind).join(','))
  console.log('\nsession log dir: ~/.dsh/sessions/…/' + sessionId)
} finally {
  await shutdown.shutdown(0)
}
process.exit(0)
