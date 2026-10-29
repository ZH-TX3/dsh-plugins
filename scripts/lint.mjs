#!/usr/bin/env node
/**
 * lint.mjs —— 无宿主依赖的静态检查，CI 与本地共用。
 *
 *   node scripts/lint.mjs
 *
 * 1. 所有 .js / .mjs 过一遍 `node --check`（语法）
 * 2. 所有 .json 能解析
 * 3. 所有 .yml 能解析（`!!js` 自定义标签先剥离，那是 cordis 的表达式）
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = new Set(['node_modules', '.git', 'dist'])
const problems = []
const counts = { js: 0, json: 0, yml: 0 }

function walk(dir, files = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) walk(abs, files)
    else files.push(abs)
  }
  return files
}

let YAML = null
try { YAML = (await import('yaml')).default ?? (await import('yaml')) } catch {
  console.log('note: yaml 包不可用，跳过 YAML 解析（CI 里会装）')
}

for (const file of walk(root)) {
  const rel = file.slice(root.length + 1)
  if (/\.(mjs|cjs|js)$/.test(file)) {
    counts.js++
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }) }
    catch (e) { problems.push(`${rel}: 语法错误 ${String(e.stderr || e.message).split('\n')[0]}`) }
  } else if (file.endsWith('.json')) {
    counts.json++
    try { JSON.parse(readFileSync(file, 'utf8')) } catch (e) { problems.push(`${rel}: JSON 解析失败 ${e.message}`) }
  } else if (/\.ya?ml$/.test(file)) {
    if (!YAML) continue
    counts.yml++
    const text = readFileSync(file, 'utf8').replace(/!!js\s+/g, '')
    try { YAML.parse(text) } catch (e) { problems.push(`${rel}: YAML 解析失败 ${e.message.split('\n')[0]}`) }
  }
}

for (const p of problems) console.log(`FAIL  ${p}`)
console.log(`\n检查 ${counts.js} 个 js/mjs、${counts.json} 个 json、${counts.yml} 个 yml`)
console.log(problems.length ? `✗ ${problems.length} 处问题` : '✓ 全部通过')
process.exit(problems.length ? 1 : 0)
