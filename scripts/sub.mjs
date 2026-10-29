#!/usr/bin/env node
/**
 * sub.mjs —— 三个 submodule（dsh-forge / dsh-web-notify / dsh-skill-mcp-gate）的统一操作。
 *
 *   node scripts/sub.mjs status    看状态：分支/指针、脏文件、领先落后
 *   node scripts/sub.mjs update    主仓 pull 之后同步工作区（高频！）
 *   node scripts/sub.mjs work      切到跟踪分支，准备改子模块代码
 *   node scripts/sub.mjs save -m "说明"   提交 + 推送 + 暂存外层指针
 *   node scripts/sub.mjs follow    子模块跟到远端分支最新（会移动指针）
 *   node scripts/sub.mjs check     一致性断言（CI 用）
 *   node scripts/sub.mjs setup     让主仓 git pull 自动带上子模块（写 repo config）
 *
 * 两个必须记住的行为：
 *
 *   1) **主仓 pull 不会自动同步子模块工作区。** 主仓里存的只是「某个 commit」的指针，
 *      `git pull` 换掉指针后，子模块目录还停在旧 commit 上。必须再跑一次
 *      `git submodule update --recursive`（= 本脚本的 update），或把 setup 打开。
 *
 *   2) **detached HEAD 是子模块的默认状态，不是错误。** 主仓锁的是 commit 而不是分支，
 *      所以 `submodule update` 必然把子模块放在 detached 上。只有要**改**子模块代码时，
 *      才 `work` 切到分支；改完 `save` 提交推送，主仓指针随之前移。
 *
 * 共同参数：--no-fetch 跳过网络（CI / 离线）
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
/** work / save 可以只作用于指定子模块：node scripts/sub.mjs work dsh-forge */
const only = argv.slice(1).filter((a) => !a.startsWith('-') && a !== message)

const git = (args, cwd = root) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (args, cwd = root) => {
  try { return git(args, cwd) } catch { return null }
}

function submodules() {
  const out = tryGit(['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'])
  if (!out) return []
  return out
    .split('\n')
    .map((line) => {
      const [key, path] = line.split(/\s+/)
      const name = key.slice('submodule.'.length, -'.path'.length)
      return { name, path, branch: tryGit(['config', '-f', '.gitmodules', `submodule.${name}.branch`]) || null }
    })
    .filter((s) => !only.length || only.includes(s.path) || only.includes(s.name))
}

/** 主仓记录的指针 */
function pointer(path) {
  return tryGit(['ls-tree', 'HEAD', path])?.match(/^160000 commit ([0-9a-f]{40})\t/)?.[1] ?? null
}

/** 暂存区里的指针（git add 之后、commit 之前） */
function stagedPointer(path) {
  return tryGit(['ls-files', '-s', '--', path])?.match(/^160000 ([0-9a-f]{40}) 0\t/)?.[1] ?? null
}

function info(sub) {
  const dir = join(root, sub.path)
  const head = tryGit(['rev-parse', 'HEAD'], dir)
  if (!head) return { ...sub, missing: true }

  const ref = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir)
  const detached = ref === 'HEAD'                 // 默认态，不是错误
  const branch = sub.branch || (detached ? null : ref)
  const dirty = (tryGit(['status', '--porcelain'], dir) ?? '').split('\n').filter(Boolean)

  let ahead = null
  let behind = null
  if (branch && !noFetch) tryGit(['fetch', '--quiet', 'origin', branch], dir)
  if (branch) {
    const lr = tryGit(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`], dir)
    if (lr) [ahead, behind] = lr.split(/\s+/).map(Number)
  }
  const ptr = pointer(sub.path)
  const staged = stagedPointer(sub.path)
  return { ...sub, head, ref, detached, branch, dirty, ahead, behind, ptr, staged, pointerDiffers: Boolean(ptr && ptr !== head) }
}

const pad = (s, n) => String(s ?? '-').padEnd(n)

function report(rows) {
  const bad = []
  for (const r of rows) {
    if (r.missing) { console.log(`  ${pad(r.path, 22)} 未初始化 → npm run sub:update`); bad.push(r); continue }
    const notes = []
    if (r.pointerDiffers) notes.push(`指针 ${r.ptr.slice(0, 8)} ≠ HEAD ${r.head.slice(0, 8)}`)
    if (r.dirty.length) notes.push(`脏 ${r.dirty.length}`)
    if (r.ahead) notes.push(`领先 ${r.ahead}`)
    if (r.behind) notes.push(`落后 ${r.behind}`)
    const state = r.detached ? 'detached(正常)' : r.branch
    console.log(`  ${pad(r.path, 22)} ${pad(state, 22)} ${notes.length ? '· ' + notes.join('  ') : '· 与指针一致'}`)
    if (r.pointerDiffers || r.dirty.length || (r.detached && r.dirty.length)) bad.push(r)
  }
  return bad
}

const rows = submodules()

switch (cmd) {
  case 'status': {
    console.log(`submodules: ${rows.length} 个${noFetch ? '（未联网）' : ''}`)
    const bad = report(rows.map(info))
    console.log(bad.length ? `\n  ${bad.length} 个需要处理` : '\n  全部就绪')
    break
  }

  // 主仓 pull 之后跑这个。高频。
  case 'update': {
    console.log('  同步子模块工作区到主仓指针 …')
    tryGit(['submodule', 'sync', '--recursive'])
    const out = tryGit(['submodule', 'update', '--init', '--recursive'])
    if (out === null) console.log('  submodule update 失败，手动排查：git submodule update --init --recursive')
    const bad = report(rows.map(info))
    if (!bad.length) console.log('\n  已对齐：工作区 == 主仓指针')
    break
  }

  // 要改子模块代码之前跑这个。
  case 'work': {
    for (const sub of rows.map(info)) {
      const dir = join(root, sub.path)
      if (sub.missing) { console.log(`  ${sub.path}: 未初始化 → npm run sub:update`); continue }
      if (!sub.branch) { console.log(`  ${sub.path}: .gitmodules 里没有 branch`); continue }
      if (!sub.detached) { console.log(`  ${sub.path}: 已在 ${sub.branch}`); continue }
      tryGit(['checkout', '--quiet', sub.branch], dir)
      console.log(`  ${sub.path}: ${sub.head.slice(0, 8)} → ${sub.branch}`)
    }
    console.log('\n  改完用 npm run sub:save -- -m "说明" 提交并推送')
    break
  }

  case 'save': {
    if (!message) { console.error('用法：npm run sub:save -- -m "提交说明"'); process.exit(2) }
    const targets = rows.map(info).filter((r) => !r.missing && r.dirty.length)
    if (!targets.length) { console.log('  没有需要提交的子模块改动'); break }

    const detached = targets.filter((r) => r.detached)
    if (detached.length) {
      // 不偷偷切分支：detached 上提交会造出游离提交
      for (const r of detached) console.log(`  ${r.path}: detached HEAD 且有改动，拒绝提交`)
      console.log('\n  先切分支：npm run sub:work' + (detached.length === 1 ? ' ' + detached[0].path : ''))
      process.exit(1)
    }

    for (const r of targets) {
      const dir = join(root, r.path)
      git(['add', '-A'], dir)
      git(['commit', '--quiet', '-m', message], dir)
      git(['push', '--quiet', 'origin', r.branch], dir)
      console.log(`  ${r.path}: 已提交并推送到 origin/${r.branch}`)
      git(['add', r.path])
    }
    console.log('\n  外层指针已暂存，提交：git commit -m "chore: 更新子模块指针"')
    break
  }

  case 'follow': {
    const moved = []
    for (const sub of rows) {
      if (!sub.branch) continue
      const dir = join(root, sub.path)
      const before = pointer(sub.path)
      if (tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir) === 'HEAD') tryGit(['checkout', '--quiet', sub.branch], dir)
      tryGit(['pull', '--quiet', '--ff-only', 'origin', sub.branch], dir)
      const head = tryGit(['rev-parse', 'HEAD'], dir)
      if (head && head !== before) {
        git(['add', sub.path])
        moved.push(sub.path)
        console.log(`  ${sub.path}: ${(before ?? '-').slice(0, 8)} → ${head.slice(0, 8)}（origin/${sub.branch}）`)
      } else {
        console.log(`  ${sub.path}: 已是最新（origin/${sub.branch}）`)
      }
    }
    console.log(moved.length ? `\n  已暂存 ${moved.length} 个指针，提交：git commit -m "chore: 跟随子模块远端"` : '\n  无需提交')
    break
  }

  case 'check': {
    const problems = []
    for (const sub of rows.map(info)) {
      if (sub.missing) { problems.push(`${sub.path}: 未初始化（git submodule update --init）`); continue }
      if (sub.dirty.length) problems.push(`${sub.path}: 有 ${sub.dirty.length} 个未提交改动`)
      if (sub.pointerDiffers) {
        const hint = sub.staged === sub.head ? '已暂存，等 git commit' : 'git add 一下再提交'
        problems.push(`${sub.path}: 指针 ${sub.ptr.slice(0, 8)} ≠ 子模块 HEAD ${sub.head.slice(0, 8)}（${hint}）`)
      }

      // 最阴的一条：指针钉在一个只存在本地的 commit 上。别人 clone 时该对象不存在，
      // 整个子模块目录直接是空的，而且错误要到那时候才出现。
      if (sub.head) {
        const refs = tryGit(['for-each-ref', '--contains', sub.head, '--format=%(refname)', 'refs/remotes/'], join(root, sub.path))
        if (refs === null || refs.trim() === '') {
          problems.push(`${sub.path}: HEAD ${sub.head.slice(0, 8)} 不在任何远端分支上（没 push？clone 方会断链）`)
        }
      }

      // detached 是默认态、落后远端也正常（主仓锁的是 commit），只作提示
      if (sub.detached) console.log(`  note  ${sub.path}: detached HEAD（默认态，改代码前 npm run sub:work）`)
      if (sub.behind) console.log(`  note  ${sub.path}: 比 origin/${sub.branch} 旧 ${sub.behind} 个提交（正常：主仓锁 commit）`)
      if (sub.ahead) console.log(`  note  ${sub.path}: 领先 origin/${sub.branch} ${sub.ahead} 个提交（还没推？npm run sub:save）`)
    }
    for (const p of problems) console.log(`  FAIL  ${p}`)
    console.log(problems.length ? `\n✗ ${problems.length} 处问题` : '\n✓ 子模块一致')
    process.exit(problems.length ? 1 : 0)
  }

  // 让 git pull / git checkout 自动递归子模块，省掉第 1 条坑
  case 'setup': {
    git(['config', 'submodule.recurse', 'true'])
    git(['config', 'submodule.fetchJobs', '4'])
    console.log('  已写入本仓 config：')
    console.log('    submodule.recurse = true   → git pull / checkout 会带上子模块')
    console.log('    submodule.fetchJobs = 4')
    console.log('\n  注意：开启后 git checkout 也会动子模块工作区，改代码期间慎用。')
    console.log('  撤销：git config --unset submodule.recurse')
    break
  }

  default:
    console.error(`未知命令：${cmd}\n可用：status | update | work | save | follow | check | setup`)
    process.exit(2)
}
