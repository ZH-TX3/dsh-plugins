/**
 * dsh-workflow-library — 把磁盘上的 `.workflow.js` 资产变成可触发的入口。
 *
 * 两个入口共享同一个 loader：
 *   1. `/wf:<name> [args]` 人类命令 —— 直接读文件喂给 ctx.workflowEngine
 *   2. `workflow_library` 模型工具 —— 模型只传 name + args，不转录脚本
 *
 * 引擎通过 serviceForAgent 从「该 agent 所属 preset 的 realm」取，因为
 * web-app 把宿主层的 workflow-ptc 关了，引擎只活在每个 preset 的 isolate realm 里。
 *
 * @module @local/dsh-workflow-library
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import vm from 'node:vm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { serviceForAgent } from '@deepseek-ai/dsh-agent-preset-registry'

export const name = 'workflow-library'
export const inject = ['commands', 'tools']

const META_HEAD = /^[ \t]*export[ \t]+const[ \t]+meta[ \t]*=/m
const META_ANYWHERE = /^[ \t]*export[ \t]+const[ \t]+meta\b/m
const META_FIELDS = new Set(['name', 'description', 'whenToUse', 'phases'])
const PHASE_FIELDS = new Set(['title', 'detail', 'provider', 'model'])
const SUFFIX = '.workflow.js'

/** meta 之前只允许空白与注释。 */
function onlyCommentsBefore(src, end) {
  let i = 0
  while (i < end) {
    const ch = src[i]
    const next = src[i + 1]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? end : nl + 1
      continue
    }
    if (ch === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2)
      if (close === -1) return false
      i = close + 2
      continue
    }
    return false
  }
  return true
}

/** 从 `=` 之后截取平衡的对象字面量，跳过字符串与注释里的括号。 */
function sliceObjectLiteral(src, start) {
  let depth = 0
  let i = start
  let inStr = null
  let inLineComment = false
  let inBlockComment = false
  for (; i < src.length; i++) {
    const ch = src[i]
    const next = src[i + 1]
    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }
    if (inStr !== null) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '/' && next === '/') {
      inLineComment = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      continue
    }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 解析一个工作流文件，返回 meta 与剥离后的 body。
 * @param source - 文件全文
 * @param path - 文件路径（仅用于报错）
 * @returns `{ meta, script }`
 * @throws 文件不合法时
 */
export function parseWorkflowFile(source, path) {
  const head = META_HEAD.exec(source)
  if (!head) throw new Error(`${path}: 缺少 \`export const meta = {...}\``)
  if (!onlyCommentsBefore(source, head.index)) {
    throw new Error(`${path}: \`export const meta\` 之前除了空白和注释不能有其它语句`)
  }
  const eq = source.indexOf('=', head.index)
  const literal = sliceObjectLiteral(source, eq + 1)
  if (literal === null) throw new Error(`${path}: meta 的对象字面量没有闭合，或不是纯字面量`)

  let meta
  try {
    meta = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 })
  } catch (error) {
    throw new Error(`${path}: meta 必须是纯字面量：${error.message}`)
  }

  const problems = []
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    problems.push('meta 必须是一个对象')
  } else {
    for (const key of Object.keys(meta)) {
      if (!META_FIELDS.has(key)) problems.push(`meta.${key} 不是可识别字段`)
    }
    if (typeof meta.name !== 'string' || meta.name.length === 0) problems.push('meta.name 必须是非空字符串')
    if (typeof meta.description !== 'string' || meta.description.length === 0) problems.push('meta.description 必须是非空字符串')
    if (meta.whenToUse !== undefined && typeof meta.whenToUse !== 'string') problems.push('meta.whenToUse 必须是字符串')
    if (meta.phases !== undefined) {
      if (!Array.isArray(meta.phases)) problems.push('meta.phases 必须是数组')
      else
        meta.phases.forEach((phase, index) => {
          if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) {
            problems.push(`meta.phases[${index}] 必须是对象`)
            return
          }
          for (const key of Object.keys(phase)) {
            if (!PHASE_FIELDS.has(key)) problems.push(`meta.phases[${index}].${key} 不是可识别字段`)
          }
          if (typeof phase.title !== 'string' || phase.title.length === 0) problems.push(`meta.phases[${index}].title 必须是非空字符串`)
        })
    }
  }
  if (problems.length > 0) throw new Error(`${path}: ${problems.join('；')}`)

  // 文件头注释与 meta 都是给人看的，丢弃后 body 只剩代码。
  const script = source.slice(eq + 1 + literal.length).replace(/^\s*;?\s*\n/, '')
  if (META_ANYWHERE.test(script)) throw new Error(`${path}: body 里仍然残留 \`export const meta\``)

  try {
    new vm.Script(`(async () => {\n${script}\n})()`, { filename: `workflow:${meta.name}` })
  } catch (error) {
    throw new Error(`${path}: body 语法错误：${error.message}`)
  }

  return { meta, script }
}

/** 项目根：最近的含 .git 的祖先目录，没有则用 cwd。 */
function findProjectRoot(cwd) {
  let current = resolve(cwd)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = resolve(current, '..')
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/** 扫描一个目录下的 `*.workflow.js`。单个文件坏掉不影响其它文件。 */
function scanDir(dir, sourceLabel, rank, out, logger) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(SUFFIX)) continue
    const path = join(dir, entry.name)
    let parsed
    try {
      parsed = parseWorkflowFile(readFileSync(path, 'utf8'), path)
    } catch (error) {
      logger?.warn(`workflow-library: 跳过 ${path}：${error.message}`)
      continue
    }
    const existing = out.get(parsed.meta.name)
    // 先扫到的 rank 更小 = 优先级更高
    if (existing !== undefined && existing.rank <= rank) continue
    out.set(parsed.meta.name, {
      name: parsed.meta.name,
      description: parsed.meta.description,
      whenToUse: parsed.meta.whenToUse,
      meta: parsed.meta,
      script: parsed.script,
      path,
      source: sourceLabel,
      rank,
    })
  }
}

/**
 * 发现所有工作流资产。
 * @param cwd - 当前会话工作目录
 * @param logger - 可选 logger
 * @returns name → 条目
 */
export function discoverWorkflows(cwd, logger) {
  const out = new Map()
  const projectRoot = findProjectRoot(cwd)
  scanDir(join(projectRoot, '.dsh', 'workflows'), 'project', 100, out, logger)
  scanDir(join(projectRoot, '.agents', 'workflows'), 'project', 200, out, logger)
  scanDir(join(homedir(), '.dsh', 'workflows'), 'user', 400, out, logger)
  return out
}

/** 把命令的 rawInput 解析成 args：合法 JSON 就用解析结果，否则当纯文本。 */
export function parseArgs(rawInput) {
  const text = (rawInput ?? '').trim()
  if (text.length === 0) return undefined
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text)
    } catch {
      // 落回纯文本
    }
  }
  return { input: text }
}

/** 解析该 agent 所属 preset realm 里的 workflow 引擎。 */
function engineFor(ctx, agent) {
  const engine = serviceForAgent(ctx, agent, 'workflowEngine')
  if (engine !== undefined) return engine
  // 退路：agent 没有 preset（或 preset 未挂引擎）时用本 ctx 解析到的实例。
  const fallback = ctx.get('workflowEngine')
  if (fallback !== undefined) return fallback
  throw new Error(
    'workflow 引擎不可用：当前 agent 的 preset 没有挂载 @deepseek-ai/dsh-workflow-ptc，且宿主层也没有。请检查该 preset 的 delegation group。',
  )
}

/** 运行一次并等到彻底停稳。 */
async function runToSettle(engine, { meta, script, args, parent, signal }) {
  const run = engine.start({ script, meta, args, parent, signal })
  const onAbort = () => run.cancel('调用方已取消')
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted === true) run.cancel('调用方已取消')
  try {
    const settled = await run.result
    return { runId: String(run.id), settled }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await run.dispose()
  }
}

/** 把结算结果变成人类/模型可读的文本。 */
function renderSettled(entry, settled, maxChars) {
  switch (settled.stopReason) {
    case 'completed': {
      const json = JSON.stringify(settled.value, null, 2) ?? 'null'
      const clipped =
        json.length > maxChars ? `${json.slice(0, maxChars)}\n… [truncated: ${json.length - maxChars} more characters]` : json
      return `workflow "${entry.name}" completed (${settled.agentsStarted} agent${settled.agentsStarted === 1 ? '' : 's'}).\nReturn value:\n${clipped}`
    }
    case 'cancelled':
      return `workflow "${entry.name}" was cancelled${settled.error === undefined ? '' : ` (${settled.error})`}`
    case 'error':
      return `workflow "${entry.name}" failed: ${settled.error ?? 'unknown error'}`
    /* v8 ignore next 2 -- WorkflowStopReason 是封闭 union */
    default:
      return `workflow "${entry.name}" ended abnormally (${String(settled.stopReason)})`
  }
}

export function apply(ctx, config) {
  const maxResultChars = config.maxResultChars ?? 50000
  const toolName = config.toolName ?? 'workflow_library'
  // 命令名必须匹配 /^[a-z][a-z0-9_-]*$/（dsh-commands 的 COMMAND_NAME），
  // 冒号不在允许字符集内，所以用连字符而不是 `wf:`。
  const commandPrefix = config.commandPrefix ?? 'wf-'
  const enableTool = config.enableTool ?? true
  const enableCommands = config.enableCommands ?? true

  const runEntry = async (entry, args, agent, signal) => {
    const engine = engineFor(ctx, agent)
    const { settled } = await runToSettle(engine, {
      meta: entry.meta,
      script: entry.script,
      args,
      parent: agent,
      signal,
    })
    return settled
  }

  // ── 入口 1：人类命令 ────────────────────────────────────────────────
  // 命令表随文件增删刷新：一次调用扫描一次，与已注册集合做差量，
  // 这样新增的脚本立刻可用，不需要重启。
  if (enableCommands) {
    ctx.effect(() => {
      /** 已注册的命令：name → { entry, dispose } */
      const registered = new Map()

      const reconcile = () => {
        // 命令注册是全局的，没有会话 cwd 可用，因此以进程 cwd 为基准扫描；
        // 项目级脚本靠启动目录命中，用户级脚本总是可见。
        const found = discoverWorkflows(process.cwd(), ctx.logger)
        // 移除已消失的
        for (const [name, record] of registered) {
          if (found.has(name)) continue
          record.dispose()
          registered.delete(name)
        }
        // 新增 / 刷新已变化的
        for (const entry of found.values()) {
          const existing = registered.get(entry.name)
          if (existing !== undefined && existing.entry.path === entry.path) continue
          existing?.dispose()
          // 单个脚本注册失败（例如名字里含命令语法不接受的字符）不能拖垮整个插件：
          // 跳过它并告警，其余命令与 workflow_library 工具照常可用。
          let dispose
          try {
            dispose = ctx.commands.register({
              name: `${commandPrefix}${entry.name}`,
              description: entry.description,
              input: { hint: '传给脚本的 args（JSON 对象，或纯文本 → { input }）' },
              handler: async (invocation) => {
                try {
                  const settled = await runEntry(entry, parseArgs(invocation.rawInput), invocation.agent, invocation.signal)
                  const text = renderSettled(entry, settled, maxResultChars)
                  return settled.stopReason === 'completed' ? { kind: 'success', text } : { kind: 'error', text }
                } catch (error) {
                  return { kind: 'error', text: `workflow "${entry.name}" 无法运行：${error.message}` }
                }
              },
            })
          } catch (error) {
            ctx.logger.warn(
              `workflow-library: 无法把 "${entry.name}" 注册为 /${commandPrefix}${entry.name}（${error.message}）；` +
                '该脚本仍可通过 workflow_library 工具运行',
            )
            continue
          }
          registered.set(entry.name, { entry, dispose })
        }
        ctx.logger.info(`workflow-library: ${registered.size} 个 /${commandPrefix}<name> 命令可用`)
      }

      reconcile()
      // 新增/删除脚本后需要重扫。用低频轮询而不是事件：commands 目录没有
      // 文件变更事件可订阅，而工具目录的变更事件会被本插件自己的注册触发，
      // 用作刷新信号会自激。10s 一次 stat-only 扫描的开销可以忽略。
      const timer = setInterval(() => {
        try {
          reconcile()
        } catch (error) {
          ctx.logger.warn(`workflow-library: 重扫失败：${String(error)}`)
        }
      }, config.rescanMs ?? 10000)
      timer.unref?.()

      return () => {
        clearInterval(timer)
        for (const record of registered.values()) record.dispose()
        registered.clear()
      }
    }, 'workflow-library commands')
  }

  // ── 入口 2：模型工具 ────────────────────────────────────────────────
  if (enableTool) {
    ctx.effect(() =>
      ctx.tools.register(
        defineTool({
          name: toolName,
          description:
            `Run a saved workflow asset by name. Assets live in .dsh/workflows/*${SUFFIX} (project) or ~/.dsh/workflows/*${SUFFIX} (user). ` +
            'Use this INSTEAD of the `workflow` tool when a suitable asset already exists: you pass only the name and args, and the runtime executes the ' +
            'file verbatim — no transcription, no token cost for the script. Call with no arguments to list what is available. ' +
            'Never invent a name: if the list does not contain what you need, use the `workflow` tool to write a script instead.',
          parameters: {
            name: {
              type: 'string',
              description: 'Workflow asset name (the meta.name inside the file). Omit to list all available assets.',
            },
            args: {
              type: 'string',
              description:
                'Optional JSON value passed to the script as the `args` global. Must be JSON text (e.g. {"topic":"x"}). Omit when the script needs no input.',
            },
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          async execute(args, exec) {
            const parent = exec.agent
            if (parent === undefined) throw new Error('workflow_library requires a calling agent (exec.agent was undefined)')
            const cwd = parent.session?.header?.cwd ?? process.cwd()
            const found = discoverWorkflows(cwd, ctx.logger)

            if (args.name === undefined || args.name.length === 0) {
              if (found.size === 0) {
                return `没有找到任何工作流资产。把 *${SUFFIX} 放进 .dsh/workflows/ 或 ~/.dsh/workflows/。`
              }
              const lines = [...found.values()]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((entry) => `- ${entry.name} [${entry.source}] — ${entry.description}`)
              return `可用工作流资产（${found.size}）：\n${lines.join('\n')}`
            }

            const entry = found.get(args.name)
            if (entry === undefined) {
              const available = [...found.keys()].sort().join(', ') || '(none)'
              throw new Error(`未知工作流资产 "${args.name}"。可用：${available}`)
            }

            let parsedArgs
            if (args.args !== undefined && args.args.length > 0) {
              try {
                parsedArgs = JSON.parse(args.args)
              } catch (error) {
                throw new Error(`args 必须是合法 JSON：${error.message}`)
              }
            }

            const settled = await runEntry(entry, parsedArgs, parent, exec.signal)
            const text = renderSettled(entry, settled, maxResultChars)
            if (settled.stopReason !== 'completed') throw new Error(text)
            return text
          },
        }),
      ),
    )
  }
}
