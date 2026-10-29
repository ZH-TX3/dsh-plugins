# @local/dsh-workflow-library

把磁盘上的 `.workflow.js` 资产变成可触发的入口。这是 DSH 版的「Claude Code dynamic workflows 资产层」。

## 它补的是什么

DSH 已经有两个东西：

- `@deepseek-ai/dsh-workflow-ptc` —— 引擎，在沙箱 PTC 进程里跑脚本
- `@deepseek-ai/dsh-tool-workflow` —— 模型工具，脚本作为**参数**提交

缺的是中间那层：**脚本作为文件资产存在，人类能一键触发**。这个插件补上它。

## 两个入口

### `/wf-<name> [args]`

```
/wf-example-fanout {"topic":"审计 src/routes 的鉴权"}
```

直接读文件、喂引擎。零转录、零 token 开销、不会改写脚本。

参数解析：合法 JSON → 原样当 `args`；否则包成 `{ input: "原文" }`；空 → `undefined`。

> **为什么是 `wf-` 不是 `wf:`** —— `dsh-commands` 的 `COMMAND_NAME` 是
> `/^[a-z][a-z0-9_-]*$/u`，冒号不在字符集内：带冒号的名字注册会被拒，
> 而且 `/wf:xxx` 连 `parseCommand` 都解析不出来。连字符是唯一可行且符合
> `<group>-<name>` 惯例的选择。

### `workflow_library` 工具

模型调用，只传 `name` + `args`。不带参数调用会列出所有可用资产。
脚本同样不转录——这是它比 `workflow` 工具省的地方。

## 资产发现

按优先级（rank 小的赢）：

| rank | 位置 | 来源标签 |
|---|---|---|
| 100 | `<projectRoot>/.dsh/workflows/*.workflow.js` | project |
| 200 | `<projectRoot>/.agents/workflows/*.workflow.js` | project |
| 400 | `~/.dsh/workflows/*.workflow.js` | user |

`<projectRoot>` = 最近的含 `.git` 的祖先目录；没有则用 cwd。

同名以先扫到的为准。单个文件解析失败只 warn、不影响其它文件。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `commandPrefix` | `wf-` | 命令前缀，`/wf-<name>` |
| `toolName` | `workflow_library` | 模型工具名 |
| `maxResultChars` | `50000` | 返回文本上限，超出截断并标注 |
| `enableCommands` | `true` | 是否注册 `/wf-` 命令 |
| `enableTool` | `true` | 是否注册 `workflow_library` 工具 |
| `rescanMs` | `10000` | 命令表重扫间隔 |

## 关键实现约束（踩过的坑）

### 引擎必须从 agent 的 preset realm 取

`dsh-web-app` 把**宿主层**的 `workflow-ptc` 设成 `disabled: true`，引擎只活在每个 preset 的
`delegation` group 里（`isolate: { workflowEngine: true }`）。

所以不能用 `ctx.workflowEngine`（在宿主层会拿到 `undefined`），必须：

```js
import { serviceForAgent } from '@deepseek-ai/dsh-agent-preset-registry'
const engine = serviceForAgent(ctx, agent, 'workflowEngine')
```

这是官方为「持有 agent 但解析发生在 realm 之外」准备的读取方式（浏览器 RPC 走的同一条路）。

### 命令注册是全局的，没有会话 cwd

`ctx.commands.register()` 拿不到 agent，所以命令扫描以 `process.cwd()` 为基准。
项目级脚本靠启动目录命中，用户级脚本总是可见。
`workflow_library` 工具则用 `exec.agent.session.header.cwd`，是准的。

### 安装副本不会自动同步

`dsh plugin add file:<dir>` 对已存在的目录依赖是**幂等空操作**——不改 specifier 就不刷新内容。
源文件改了以后要：

```bash
dsh plugin --profile web remove @local/dsh-workflow-library
dsh plugin --profile web add file:D:/ds/dsh-plugins/dsh-workflow-library
```

pnpm 在 `nodeLinker: hoisted` 下用**硬链接**。原地编辑会同步（同一 inode），
但编辑器若「写临时文件再 rename」保存，硬链接断开，副本就停在旧内容——重跑上面两条即可。

### 裸 Node 下 import 会失败，这是正常的

插件 import 的 `@deepseek-ai/*` 包在 DSH 启动时由 `installRuntimeInterception()`
路由到安装级包表。脱离 boot 直接 `node xxx.js` 会报 `ERR_MODULE_NOT_FOUND`，
**不代表插件坏了**。真实 Cordis 挂载已实测通过。

`~/.dsh/profiles/node_modules` 那层 202 个 shim 符号链接不完整（dsh 自带 286 个包，
缺 84 个，`dsh-agent-preset-registry` 就在缺的那批里），所以裸 Node 下有时能解析
`dsh-tools` 却解析不到 `dsh-agent-preset-registry`——这个不对称纯属 shim 覆盖不全。

## 安装

```bash
dsh plugin --profile web add file:D:/ds/dsh-plugins/dsh-workflow-library
```

装完**必须重启 dsh web** 才会加载（新包需要新模块代际）。

## 与方案 A（skill 承载）的关系

方案 A（`workflow-authoring` skill）让模型读脚本再转录给 `workflow` 工具，
适合临时任务；本插件让脚本**不经过模型**，适合固定流程。
两者共用同一个资产目录，可以并存。
