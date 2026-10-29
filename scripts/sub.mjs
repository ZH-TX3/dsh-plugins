#!/usr/bin/env node
/**
 * sub.mjs —— 三个 submodule（dsh-forge / dsh-web-notify / dsh-skill-mcp-gate）的统一操作。
 *
 *   node scripts/sub.mjs status            看状态：分支、脏文件、领先/落后、外层指针
 *   node scripts/sub.mjs pull              拉取各子模块跟踪分支（只 fast-forward，不提交）
 *   node scripts/sub.mjs save -m "msg"     提交并推送各子模块的改动，再更新外层指针
 *   node scripts/sub.mjs sync              外层指针跟随远端分支（不碰工作区文件）
 *   node scripts/sub.mjs check             断言一致：干净 + 指针 == HEAD == 远端（CI 用）
 *
 * 共同参数：--no-fetch 跳过网络（CI / 离线）
 *
 * 为什么需要这些：子模块是 **detached HEAD**，直接 commit 会造出游离提交；
 * 而「推了子模块却忘了提交外层指针」会让别人 clone 到旧代码。两者都由 check 拦。
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'status'
const noFetch = argv.includes('--no-fetch')
const msgIdx = argv.findIndex((a) => a === '-m' || a === '--message')
const message = msgIdx > -1 ? argv[msgIdx + 1] : null

const git = (args, cwd = root) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (args, cwd = root) => {
  try { return git(args, cwd) } catch { return null }
}

/** 从 .gitmodules 读 [{name, path, branch}] */
function submodules() {
  const out = tryGit(['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'])
  if (!out) return []
  return out.split('\n').map((line) => {
    const [key, path] = line.split(/\s+/)
    const name = key.slice('submodule.'.length, -'.path'.length)
    return { name, path, branch: tryGit(['config', '-f', '.gitmodules', `submodule.${name}.branch`]) || null }
  })
}

/** 外层仓记录的子模块指针 */
function pointer(path) {
  const out = tryGit(['ls-tree', 'HEAD', path])
  const m = out?.match(/^160000 commit ([0-9a-f]{40})\t/)
  return m ? m[1] : null
}

function info(sub) {
  const dir = join(root, sub.path)
  const head = tryGit(['rev-parse', 'HEAD'], dir)
  if (!head) return { ...sub, missing: true }

  const ref = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir) // detached 时是 "HEAD"
  const detached = ref === 'HEAD'
  const branch = sub.branch || (detached ? null : ref)
  const dirty = (tryGit(['status', '--porcelain'], dir) ?? '').split('\n').filter(Boolean)

  let upstream = null
  let ahead = null
  let behind = null
  if (branch && !noFetch) tryGit(['fetch', '--quiet', 'origin', branch], dir)
  if (branch) {
    upstream = tryGit(['rev-parse', '--verify', `origin/${branch}`], dir)
    if (upstream) {
      const lr = tryGit(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`], dir)
      if (lr) [ahead, behind] = lr.split(/\s+/).map(Number)
    }
  }
  const ptr = pointer(sub.path)
  return { ...sub, head, ref, detached, branch, dirty, upstream, ahead, behind, ptr, pointerDiffers: Boolean(ptr && head && ptr !== head) }
}

function fmt(n) { return n === null ? '?' : String(n).padStart(2) }

function printStatus(rows) {
  const problems = []
  for (const r of rows) {
    const name = r.path.padEnd(22)
    if (r.missing) { console.log(`  ${name} 未初始化（跑 npm run sub:pull 或 sub:init）`); problems.push(r); continue }
    const flags = []
    if (r.detached) flags.push('DETACHED')
    if (r.dirty.length) flags.push(`脏 ${r.dirty.length}`)
    if (r.ahead) flags.push(`领先 ${r.ahead}`)
    if (r.behind) flags.push(`落后 ${r.behind}`)
    console.log(
      `  ${name} ${(r.branch ?? '-').padEnd(16)} ↑${fmt(r.ahead)} ↓${fmt(r.behind)} ` +
        `${r.head?.slice(0, 8) ?? '-'} ${flags.length ? '· ' + flags.join(' ') : '· clean'}`,
    )
    if (r.pointerDiffers) console.log(`  ${' '.repeat(22)} 外层指针 ${r.ptr.slice(0, 8)} ≠ HEAD（需要 git add ${r.path}）`)
    // detached 本身正常（CI 的 submodule 恒为 detached）；只有带改动才危险
    if (r.dirty.length || r.pointerDiffers || r.behind || (r.detached && r.dirty.length)) problems.push(r)
  }
  return problems
}

const rows = submodules()

switch (cmd) {
  case 'status': {
    console.log(`submodules: ${rows.length} 个${noFetch ? '（未联网）' : ''}`)
    const problems = printStatus(rows.map(info))
    console.log(problems.length ? `\n  ${problems.length} 个需要处理：npm run sub:pull / sub:save` : '\n  全部干净且同步')
    break
  }

  case 'pull': {
    for (const sub of rows) {
      const i = info({ ...sub, branch: sub.branch })
      if (i.missing) {
        console.log(`  ${sub.path}: 未初始化 → git submodule update --init ${sub.path}`)
        tryGit(['submodule', 'update', '--init', '--', sub.path])
        continue
      }
      if (i.dirty.length) { console.log(`  ${sub.path}: 有未提交改动，跳过（先 npm run sub:save）`); continue }
      if (!i.branch) { console.log(`  ${sub.path}: 拿不到分支名，跳过`); continue }
      if (i.detached) git(['checkout', '--quiet', i.branch], join(root, sub.path))
      try {
        git(['pull', '--quiet', '--ff-only', 'origin', i.branch], join(root, sub.path))
        console.log(`  ${sub.path}: 已更新到 origin/${i.branch}`)
      } catch {
        console.log(`  ${sub.path}: 非 fast-forward，手动处理（git -C ${sub.path} log --oneline HEAD..origin/${i.branch}）`)
      }
    }
    const after = printStatus(rows.map(info))
    const needAdd = after.filter((r) => r.pointerDiffers)
    if (needAdd.length) {
      git(['add', ...needAdd.map((r) => r.path)])
      console.log(`\n  已暂存外层指针：${needAdd.map((r) => r.path).join(', ')}`)
      console.log('  确认后提交：git commit -m "chore: 更新子模块指针"')
    }
    break
  }

  case 'save': {
    if (!message) { console.error('用法：npm run sub:save -- -m "提交说明"'); process.exit(2) }
    let touched = 0
    for (const sub of rows) {
      const i = info(sub)
      if (i.missing || !i.dirty.length) continue
      const dir = join(root, sub.path)
      git(['add', '-A'], dir)
      git(['commit', '--quiet', '-m', message], dir)
      const branch = i.branch ?? sub.branch
      if (!branch) { console.log(`  ${sub.path}: 已提交（detached，未推送）`); touched++; continue }
      if (i.detached) git(['checkout', '--quiet', '-B', branch], dir)
      git(['push', '--quiet', 'origin', branch], dir)
      console.log(`  ${sub.path}: 已提交并推送到 origin/${branch}`)
      touched++
    }
    if (!touched) { console.log('  没有需要提交的子模块改动'); break }
    git(['add', ...rows.map((r) => r.path)])
    console.log('\n  外层指针已暂存，提交：git commit -m "chore: 更新子模块指针"')
    break
  }

  case 'sync': {
    const changed = []
    for (const sub of rows) {
      if (!sub.branch) continue
      const before = pointer(sub.path)
      tryGit(['submodule', 'update', '--remote', '--', sub.path])
      const head = tryGit(['rev-parse', 'HEAD'], join(root, sub.path))
      if (head && head !== before) {
        git(['add', sub.path])
        changed.push(sub.path)
        console.log(`  ${sub.path}: ${(before ?? '-').slice(0, 8)} → ${head.slice(0, 8)}（origin/${sub.branch}）`)
      } else {
        console.log(`  ${sub.path}: 已是最新（origin/${sub.branch}）`)
      }
    }
    console.log(
      changed.length
        ? `\n  已暂存 ${changed.length} 个指针，提交：git commit -m "chore: 同步子模块到远端"`
        : '\n  无需提交',
    )
    break
  }

  case 'check': {
    const problems = []
    for (const sub of rows.map(info)) {
      const where = sub.path
      if (sub.missing) { problems.push(`${where}: 未初始化`); continue }
      if (sub.dirty.length) {
        problems.push(`${where}: 有 ${sub.dirty.length} 个未提交改动${sub.detached ? '（且是 detached，先 git checkout ' + (sub.branch ?? '<branch>') + '）' : ''}`)
      }
      if (sub.pointerDiffers) problems.push(`${where}: 外层指针与 HEAD 不一致（忘了 git add）`)
      if (sub.behind) problems.push(`${where}: 落后 origin/${sub.branch} ${sub.behind} 个提交（npm run sub:pull）`)
      if (sub.ahead) console.log(`  note  ${where}: 领先 origin/${sub.branch} ${sub.ahead} 个提交（还没推？npm run sub:save）`)
    }
    for (const p of problems) console.log(`  FAIL  ${p}`)
    console.log(problems.length ? `\n✗ ${problems.length} 处问题` : '\n✓ 子模块一致')
    process.exit(problems.length ? 1 : 0)
  }

  default:
    console.error(`未知命令：${cmd}\n可用：status | pull | save | sync | check`)
    process.exit(2)
}
