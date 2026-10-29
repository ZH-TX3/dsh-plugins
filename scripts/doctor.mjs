#!/usr/bin/env node
/**
 * doctor.mjs —— 单一源目录自检。`link:` 装载之后，跑它能一次性指出所有会静默失效的地方。
 *
 * 检查项：
 *   1. profile package.json 里每个本地包条目是否指向真实存在的目录
 *   2. 每个 bundle patch 里的 `file:///...` 绝对路径是否还在（搬家/改名后必查）
 *   3. 宿主 junction 是否指向当前运行的 dsh
 *   4. 各包声明的 dsh 兼容版本是否覆盖当前宿主
 *
 * 用法：node scripts/doctor.mjs [--profile web]
 *   DSH 升级后第一件事就是跑这个。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
const profileArg = process.argv.indexOf('--profile')
const profile = profileArg > -1 ? process.argv[profileArg + 1] : process.env.DSH_PROFILE || 'web'
const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME, '.dsh')
const profileDir = join(dshHome, 'profiles', profile)

let problems = 0
const ok = (m) => console.log(`  ok   ${m}`)
const bad = (m) => { problems++; console.log(`  FAIL ${m}`) }
const warn = (m) => console.log(`  warn ${m}`)

console.log(`doctor — root=${root}`)
console.log(`doctor — profile=${profileDir}\n`)

/* 1. profile 里的本地条目 */
console.log('[1] profile 本地包条目')
const pkgPath = join(profileDir, 'package.json')
const pkg = readJson(pkgPath)
if (!pkg) {
  bad(`${pkgPath} 读不到`)
} else {
  const local = Object.entries(pkg.dependencies ?? {}).filter(([, v]) => /^(link|file):/.test(v))
  if (!local.length) warn('没有本地包条目')
  for (const [name, spec] of local) {
    const target = spec.replace(/^(link|file):/, '')
    const abs = target.startsWith('D:') || target.startsWith('C:') ? target : resolve(profileDir, target)
    existsSync(abs) ? ok(`${name} → ${abs}`) : bad(`${name} → ${abs} 不存在`)
  }
  const bundles = new Set(pkg.dsh?.profile?.bundles ?? [])
  for (const [name] of local) {
    if (!bundles.has(name)) warn(`${name} 装了但不在 dsh.profile.bundles 里（不会加载）`)
  }
}

/* 2. patch 里的绝对 path */
console.log('\n[2] patch 里的 file:/// 绝对路径')
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(patch\.yml|yml)$/.test(e.name)) out.push(p)
  }
  return out
}
for (const file of walk(root)) {
  const text = readFileSync(file, 'utf8')
  const refs = [...text.matchAll(/file:\/\/\/([A-Za-z]:[^\s'"#]+)/g)].map((m) => m[1])
  if (!refs.length) continue
  const missing = refs.filter((r) => !existsSync(r.replace(/\//g, '\\')))
  const short = file.slice(root.length + 1)
  missing.length
    ? bad(`${short}: ${missing.length}/${refs.length} 个路径不存在，首个 = ${missing[0]}`)
    : ok(`${short}: ${refs.length} 个路径均存在`)
}

/* 3. 宿主 junction */
console.log('\n[3] 宿主 junction')
try {
  execFileSync(process.execPath, [join(root, 'scripts', 'link-host.mjs'), '--check'], { stdio: 'inherit' })
} catch {
  problems++
}

/* 4. 兼容版本声明 */
console.log('\n[4] 各包 dsh 兼容声明')
const host = [
  join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'),
  process.env.DSH_CORE_DIR,
].filter(Boolean).find((p) => existsSync(join(p, 'package.json')))
const hostVersion = host ? readJson(join(host, 'package.json'))?.version : null
console.log(`  当前宿主 dsh = ${hostVersion ?? '未知'}`)
for (const dir of readdirSync(root, { withFileTypes: true })) {
  if (!dir.isDirectory() || ['node_modules', 'scripts', 'docs', 'forks'].includes(dir.name)) continue
  const p = join(root, dir.name, 'package.json')
  const j = readJson(p)
  if (!j) continue
  const releases = j.dsh?.compatibility?.dshReleases
  const range = j.dsh?.compatibility?.dsh ?? j.engines?.dsh
  if (releases) {
    releases[hostVersion] ? ok(`${j.name} 声明 ${hostVersion} 为 compatible`) : warn(`${j.name} 的 dshReleases 没有 ${hostVersion}，需补一行`)
  } else if (range) {
    ok(`${j.name} 声明 dsh ${range}`)
  } else {
    warn(`${j.name} 没有任何 dsh 版本声明（升级后不会报不兼容，只会静默失效）`)
  }
}

console.log(`\n${problems ? `✗ ${problems} 处问题` : '✓ 全部通过'}`)
process.exit(problems ? 1 : 0)
