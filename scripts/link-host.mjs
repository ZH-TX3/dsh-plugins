#!/usr/bin/env node
/**
 * link-host.mjs —— 把宿主 peer 包以 junction 挂到本目录的 node_modules 下。
 *
 * 为什么需要：
 *   profile 里用 `link:` 装载的插件，模块解析会从真实路径（本目录）往上找
 *   node_modules。插件里 `import '@deepseek-ai/dsh-tools'` 只有能找到宿主包时才成立。
 *   把宿主包**复制**一份会锁死版本（升级 dsh 后插件拿旧 API 打新宿主，报错现场对不上），
 *   所以这里只建 junction 指向当前运行的 host —— 宿主换版本，链接自动跟着换。
 *
 * 用法：
 *   node scripts/link-host.mjs            # 建立/修复链接
 *   node scripts/link-host.mjs --check    # 只检查不动文件（doctor 用）
 *
 * 升级 dsh 之后必跑一次（node 版本变了也要跑，因为宿主安装路径会变）。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const WANTED = ['dsh-tools', 'dsh-agent-preset-registry', 'cordis', 'schemastery']
const checkOnly = process.argv.includes('--check')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nm = join(root, 'node_modules', '@deepseek-ai')

const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

/** 候选宿主安装根：显式指定 → 当前 node 旁 → npm 全局 → PATH 上的 dsh。 */
function findHosts() {
  const out = []
  if (process.env.DSH_CORE_DIR) out.push(process.env.DSH_CORE_DIR)
  out.push(join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'))
  if (process.env.APPDATA) out.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  try {
    const p = execFileSync('where', ['dsh'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (p) out.push(join(dirname(p), 'node_modules', '@deepseek-ai', 'dsh'))
  } catch {}
  return [...new Set(out)]
}

/** 包可能装在宿主顶层，也可能在 dsh 自己的 node_modules 里。 */
function resolveIn(host, name) {
  return [
    join(host, 'node_modules', '@deepseek-ai', name),
    join(host, '..', name),
  ].find((p) => existsSync(join(p, 'package.json'))) ?? null
}

const host = findHosts().find((h) => existsSync(join(h, 'package.json')))
if (!host) {
  console.error('[link-host] 找不到 dsh 宿主。设 DSH_CORE_DIR 指向 node_modules/@deepseek-ai/dsh 后重试。')
  process.exit(1)
}

const norm = (p) => p.replace(/\\/g, '/').toLowerCase()
console.log(`[link-host] host = ${host}`)
console.log(`[link-host] dsh  = ${readJson(join(host, 'package.json'))?.version ?? '?'}`)

if (!checkOnly) mkdirSync(nm, { recursive: true })

let bad = 0
for (const name of WANTED) {
  const target = resolveIn(host, name)
  const link = join(nm, name)

  if (!target) {
    console.warn(`[link-host] 缺失 ${name}：宿主里没有（可能已改名/拆包），需人工确认`)
    bad++
    continue
  }

  let current = null
  try {
    const st = lstatSync(link)
    if (st.isSymbolicLink() || st.isDirectory()) current = readlinkSync(link)
  } catch {}

  const version = readJson(join(target, 'package.json'))?.version ?? '?'

  if (current && norm(current) === norm(target)) {
    console.log(`[link-host] ok   ${name}@${version}`)
    continue
  }

  if (checkOnly) {
    console.warn(`[link-host] 失配 ${name}：期望 ${target}，实际 ${current ?? '不存在'}`)
    bad++
    continue
  }

  try {
    if (current) rmSync(link, { recursive: true, force: true })
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore', windowsHide: true })
    } else {
      execFileSync('ln', ['-sfn', target, link], { stdio: 'ignore' })
    }
    console.log(`[link-host] 新建 ${name}@${version}`)
  } catch (e) {
    console.error(`[link-host] 失败 ${name}：${e.message}`)
    bad++
  }
}

process.exit(bad ? 1 : 0)
