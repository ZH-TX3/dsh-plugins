#!/usr/bin/env node
/**
 * check-specs.mjs —— 不依赖宿主的静态检查。CI 与 `doctor.mjs` 共用同一份逻辑。
 *
 * 检查 patch 里每个插件 spec 能不能在**任何装法**下解析：
 *   1. `file:///`、`D:/…`、`/abs` 这类绝对路径 —— 禁止。打包分发后会指向源码目录，
 *      跑起来的是另一份代码，属于最难查的静默分叉。
 *   2. `./x` 相对路径 —— 禁止。预设子行的 baseUrl 是 profile 根，不是本目录。
 *   3. `@scope/pkg/…` 且属于本仓的包 —— 映射回仓库目录，断言文件真实存在。
 *   4. 裸包名（@deepseek-ai/…）属于宿主，跳过。
 *
 * 直跑：node scripts/check-specs.mjs
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 仓库里所有包：目录 → {name, dir}。跳过 node_modules / .git。 */
export function collectPackages(root = join(here, '..')) {
  const map = new Map()
  const walk = (dir, depth) => {
    if (depth > 2) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue
      const abs = join(dir, e.name)
      const pkgFile = join(abs, 'package.json')
      if (existsSync(pkgFile)) {
        try {
          const j = JSON.parse(readFileSync(pkgFile, 'utf8'))
          if (j.name) map.set(j.name, { dir: abs, json: j })
        } catch {}
      } else {
        walk(abs, depth + 1)
      }
    }
  }
  walk(root, 0)
  return map
}

/** 所有 patch 文件（*.yml / *.patch.yml），跳过 node_modules 与 .git。 */
export function collectPatches(root = join(here, '..')) {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const abs = join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.name.endsWith('.yml') && /patch\.ya?ml$|presets[/\\].*\.ya?ml$/.test(abs)) out.push(abs)
    }
  }
  walk(root)
  return out
}

export function checkPatchSpecs(root = join(here, '..')) {
  const pkgs = collectPackages(root)
  const problems = []
  const notes = []
  // 引号可有可无：`name: dsh-skill-mcp-gate` 与 `name: '@local/x/y.js'` 都要认。
  const specRe = /^\s*-?\s*name:\s*['"]?([^'"\n]+?)['"]?\s*$/gm
  const absRe = /^(file:\/\/\/|[A-Za-z]:[\\/]|\/)/
  const relRe = /^\.\.?\//
  const ownerOf = (spec) =>
    [...pkgs.keys()].filter((n) => spec === n || spec.startsWith(n + '/')).sort((a, b) => b.length - a.length)[0]

  for (const file of collectPatches(root)) {
    const text = readFileSync(file, 'utf8')
    const rel = file.slice(root.length + 1)
    let count = 0
    for (const m of text.matchAll(specRe)) {
      const spec = m[1].trim()
      if (!spec) continue
      const owner = ownerOf(spec)
      // 只处理「像 spec 的东西」：本仓包名、带 / 或 @ 的、带扩展名的、绝对路径。
      // 预设的显示名（锻造模式 / 边界扩展模式）和 harness:identity 这类会被跳过。
      const looksLikeSpec = owner || absRe.test(spec) || /[@/]/.test(spec) || /\.m?js$/.test(spec)
      if (!looksLikeSpec) continue
      if (spec.startsWith('@deepseek-ai/') || spec.startsWith('node:')) continue // 宿主包
      count++
      if (absRe.test(spec)) {
        problems.push(`${rel}: 禁止绝对路径 spec（打包后指向源码目录） → ${spec}`)
        continue
      }
      if (relRe.test(spec)) {
        problems.push(`${rel}: 禁止 ./ 相对路径 spec（baseUrl 是 profile 根） → ${spec}`)
        continue
      }
      if (!owner) {
        notes.push(`${rel}: 未归属本仓的 spec（按宿主包处理） → ${spec}`)
        continue
      }
      const inner = spec.slice(owner.length + 1)
      const target = inner ? join(pkgs.get(owner).dir, ...inner.split('/')) : pkgs.get(owner).dir
      if (!existsSync(target)) problems.push(`${rel}: spec 指向不存在的文件 → ${spec}`)
    }
    if (count === 0) notes.push(`${rel}: 没有本地包 spec（纯宿主行）`)
  }
  return { problems, notes, packages: [...pkgs.keys()] }
}

const isMain = (() => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) }
  catch { return false }
})()

if (isMain) {
  const root = join(here, '..')
  const { problems, notes, packages } = checkPatchSpecs(root)
  console.log(`包: ${packages.length} 个`)
  for (const n of notes) console.log(`  note  ${n}`)
  for (const p of problems) console.log(`  FAIL  ${p}`)
  console.log(problems.length ? `\n✗ ${problems.length} 处问题` : '\n✓ spec 全部可解析')
  process.exit(problems.length ? 1 : 0)
}
