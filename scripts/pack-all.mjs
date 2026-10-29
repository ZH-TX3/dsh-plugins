#!/usr/bin/env node
/**
 * pack-all.mjs —— 把可分发插件打成 .tgz，并生成 manifest.json / RELEASE.md。
 *
 *   node scripts/pack-all.mjs            # 产物落在 dist/
 *   TAG=v0.1.0 node scripts/pack-all.mjs # 生成带 release URL 的 manifest
 *
 * 分发范围只含**第一方**包（6 个）。forks/ 下两个是上游项目的本地补丁，
 * 授权与版本都归上游，不在本仓发 release。
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

const DISTRIBUTABLE = [
  'dsh-forge',
  'dsh-web-notify',
  'dsh-skill-mcp-gate',
  'dsh-session-continuity',
  'dsh-workflow-library',
  'agent-presets-bundle',
]

const tag = process.env.TAG || process.argv[2] || 'v0.0.0-local'
const repo = process.env.GITHUB_REPOSITORY || 'ZH-TX3/dsh-plugins'
const baseUrl = `https://github.com/${repo}/releases/download/${tag}`

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const rows = []
for (const dir of DISTRIBUTABLE) {
  const pkgDir = join(root, dir)
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))

  const patches = [].concat(pkg.dsh?.bundle?.patch ?? [])
  if (!patches.length) throw new Error(`${dir}: 没有 dsh.bundle.patch`)
  const missing = patches.filter((f) => !existsSync(join(pkgDir, f)))
  if (missing.length) throw new Error(`${dir}: bundle patch 缺失 ${missing.join(', ')}`)

  const out = execSync(`npm pack "${pkgDir}" --pack-destination "${dist}" --silent`, {
    encoding: 'utf8',
    cwd: root,
  })
    .trim()
    .split('\n')
    .pop()
    .trim()

  const buf = readFileSync(join(dist, out))
  rows.push({
    package: pkg.name,
    version: pkg.version,
    dir,
    file: out,
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    url: `${baseUrl}/${out}`,
  })
  console.log(`  packed  ${pkg.name.padEnd(30)} ${String(pkg.version).padEnd(14)} ${out}`)
}

const manifest = { repo, tag, generatedAt: new Date().toISOString(), packages: rows }
writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

const deps = rows.map((r, i) => `    "${r.package}": "${r.url}"${i === rows.length - 1 ? '' : ','}`)
const notes = [
  `# ${tag}`,
  '',
  `共 ${rows.length} 个可分发插件。装法（profile 的 \`package.json\`）：`,
  '',
  '```jsonc',
  '{',
  '  "dependencies": {',
  ...deps,
  '  }',
  '}',
  '```',
  '',
  '| 包 | 版本 | 文件 | sha256 |',
  '|---|---|---|---|',
  ...rows.map((r) => `| \`${r.package}\` | ${r.version} | \`${r.file}\` | \`${r.sha256.slice(0, 12)}…\` |`),
  '',
  '> `forks/` 下两个第三方 fork 不在此次分发内：它们是上游项目的本地补丁，',
  '> 版本与授权归上游，请从各自上游安装。',
  '',
].join('\n')
writeFileSync(join(dist, 'RELEASE.md'), notes)

// 给「另一台机器复现当前状态」用的现成片段：直接合进 profile 的 package.json
const fragment = {
  $comment: '把 dependencies 合进 profile 的 package.json，并把 bundles 里的包名加进 dsh.profile.bundles',
  tag,
  dependencies: Object.fromEntries(rows.map((r) => [r.package, r.url])),
  bundles: rows.map((r) => r.package),
  verification: {
    why: '装完后跑一次，确认 spec 在 profile 的 node_modules 里能解析',
    command: 'node -e "import(\'@local/dsh-forge/features/persona/index.js\').then(()=>console.log(\'ok\'))"',
  },
}
writeFileSync(join(dist, 'profile-fragment.json'), JSON.stringify(fragment, null, 2) + '\n')

console.log(`\n  ${rows.length} 个包 → dist/（含 manifest.json、RELEASE.md、profile-fragment.json）`)
