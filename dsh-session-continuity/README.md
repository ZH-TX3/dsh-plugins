# dsh-session-continuity

DSH（DeepSeek Harness）会话连续性插件。把当前会话状态保存为项目级 `HANDOFF.md`，在**新会话**里用一条浮层横幅提示加载，点「加载」后由模型读取并归档，实现跨会话无缝续接。

- 目标版本：dsh `0.2.0-rc.2`
- 插件形态：Host 插件 + Web Client 插件 + Claude Code Hooks 桥接
- 安装方式：`dsh plugin --profile web add <本目录>`（本机为 profile `web` 的 link 依赖）

---

## 1. 目录结构

```text
dsh-session-continuity/
├── package.json              # dsh.bundle / dsh.client 清单
├── cordis.patch.yml          # bundle patch：插入插件行
├── index.js                  # Host 半边：HTTP API + Handoff/状态判定
├── client.js                 # Browser 半边：横幅 UI + 载入动作
├── config/default.json       # 默认配置（promptMode / staleDays）
├── hooks/                    # 可选：Claude Code 桥接（本机已 disabled，见 6.3）
│   ├── hooks.json            # SessionStart + UserPromptSubmit + PostToolUse
│   ├── session-start.py      # 新会话注入「加载/跳过」指令
│   ├── user-prompt-submit.py # 识别「加载」并注入执行指令
│   ├── post-tool-use.py      # read 到 HANDOFF.md 后自动归档
│   ├── handoff.py            # HANDOFF.md 读写/归档/元数据
│   ├── locking.py            # 文件锁
│   └── lib/                  # paths / state / config
└── skills/save-state/SKILL.md # /save-state：生成 HANDOFF.md
```

---

## 2. 运行时数据

| 路径 | 作用 |
|---|---|
| `<projectRoot>/.dsh/HANDOFF.md` | 待加载的状态文件（frontmatter + 正文） |
| `<projectRoot>/.dsh/session-continuity/state.json` | 插件状态：`{ "dismissed": "<path>@<mtime>" }` |
| `<projectRoot>/.dsh/session-continuity/history/` | 已加载/归档的 Handoff，命名 `HANDOFF-YYYY-MM-DD-HHMMSS.md` |
| `<projectRoot>/.dsh/session-continuity/logs/hook.log` | Hook 运行日志 |
| `<projectRoot>/.dsh/session-continuity.json` | 可选项目配置：`handler` / `handoff.promptMode` / `handoff.staleDays` |
| `~/.dsh/session-continuity-logs/<date>.log` | Host 诊断日志（默认静默，`config.debug` 或 `DSH_SESSION_CONTINUITY_DEBUG=1` 开启） |

`projectRoot` 算法与 DSH 一致：从 cwd 向上找最近的 `.git`，找不到则回退到 cwd 本身。

---

## 3. 整体生命周期

```text
┌─────────────────────────────────────────────────────────────────┐
│ 会话 A：用户执行 /save-state                                     │
│   hooks/handoff.py 原子写入 <project>/.dsh/HANDOFF.md           │
└───────────────────────────────┬─────────────────────────────────┘
                                │ 新 Handoff 版本（path + mtime）
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ 会话 B：用户点「新对话」（同工作区）                              │
│   1. 宿主 agent/created 注入「加载」说明（不经过 shell）          │
│   2. Client 横幅挂载 → GET /handoff?blank=1                      │
│   3. Host 判定 blank && !dismissed → relevant=true               │
│   4. 横幅显示（360px 浮层，输入卡片上方）                         │
└───────────────────────────────┬─────────────────────────────────┘
                                │ 点击「加载」
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. Client：setDraft('加载') + submit()                           │
│ 6. 模型收到「加载」→ 只用 read 读取 HANDOFF.md，原样展示          │
│ 7. 宿主 tools/post-execute 检测到 read，直接 rename 归档          │
│ 8. Client 每 2.5s 轮询；present=false 后横幅收起                 │
└─────────────────────────────────────────────────────────────────┘
```

**「跳过」** 不产生模型回合：客户端直接 `POST action=dismiss`，按 Handoff 版本记一次忽略。

---

## 4. Host 半边（index.js）

### 4.1 职责

1. 通过 `webServer` 暴露 Handoff 状态与动作 API；
2. 判定「当前会话是否应提示」；
3. 维护 `state.json`（跳过状态）与归档动作。

只注入 `webServer`；模型交互通过 `agent/created` 与 `tools/post-execute` 事件完成，不经过 shell。

### 4.2 API

`GET/POST /dsh-session-continuity/api/handoff`

| 方法 | action | 说明 |
|---|---|---|
| GET | `state`（默认） | 返回快照，客户端据此决定是否显示 |
| POST | `read` | 返回去掉 frontmatter 的正文（仅用户明确点击后） |
| POST | `dismiss` | 记录 `dismissed = path@mtime` |
| POST | `archive` | 把 `HANDOFF.md` 移入 `history/HANDOFF-YYYY-MM-DD-HHMMSS.md` |

查询参数：`cwd`（必填）、`sessionId`、`blank=1`（仅新会话）。

### 4.3 快照字段（节选）

```json
{
  "present": true,
  "path": "D:/proj/.dsh/HANDOFF.md",
  "projectRoot": "D:/proj",
  "source": "save-state",
  "quality": "curated",
  "size": 2337,
  "updatedAt": "2026-10-20T16:40:18+08:00",
  "mtimeLabel": "2026-10-20T08:40:18.000Z",
  "relative": "约 2 分钟前",
  "stale": false,
  "staleDays": 3,
  "handled": false,
  "blank": true,
  "relevant": true
}
```

### 4.4 核心判据

```js
relevant = Boolean(sessionId) && blank === true && !handled
handled  = state.dismissed === `${path}@${meta.mtime}`
```

**不用会话创建时间。** 原因：

- DSH 的 New Session 会复用同工作区的空白会话，复用出来的会话 `createdAt` 早于 Handoff；
- 新会话首帧时 `agent/created` 尚未触发，插件内存里拿不到 `createdAt`；
- `blank` 是 DSH 官方定义（`sessionListMetadata.blank`，从未出现 `turn/start`），与 UI 的 hero 判定同源。

### 4.5 版本化跳过

`state.json` 只有 `dismissed` 一个字段，值为 `path@mtime`：

- 同一份 Handoff 被跳过一次后，再开多少新会话都不再提示；
- 重新 `save-state` 会写入新 mtime → 新 token → 自动恢复提示；
- 归档时清除对应 token。

旧版的 `handledSessions` / `claimedBy` 会被直接忽略，并在下次写入时覆盖。

---

## 5. Client 半边（client.js）

### 5.1 注册位置

```js
ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
  name: 'conversation.input.dock',
  id: 'session-continuity-handoff',
  order: 10,
}, Banner))
```

**不能用 `conversation.composer.dock`。** 宿主源码（`dsh-client-ui-conversation`）里该槽位有硬门禁：

```js
variant === "composer" && input !== undefined && sessionId !== undefined
  ? renderSlot("conversation.composer.dock", {}) : null
```

新会话处于 `hero` 阶段，`variant === "hero"`，槽位根本不存在，所以旧实现「新对话永远不弹、老对话反而弹」。

`conversation.input.dock` 在 hero 与 active 两个阶段都会渲染，是「输入卡片上方」的官方扩展点。

### 5.2 数据读取

| 值 | 来源 |
|---|---|
| `cwd` | `useSessions(s => s.byId[sessionId])` |
| `blank` | `useSession(s => s.blank)` |
| 输入动作 | `props.inputActions`（`setDraft` / `submit`） |
| 是否 subagent | `session.subagent` / `row.origin` |

**不要在 `register` 的 `inject()` 里读会话列表。** Renderer 按 `(entry × session binding)` 缓存 inject 结果（`cachedSessionInject`），会话列表后到时不会重算，新会话首帧拿到的 `cwd: undefined` 会永久冻结。

### 5.3 布局：零高度锚点 + 绝对定位

```js
anchor: {
  position: 'relative',
  width: '100%',
  height: 0,
  marginTop: 'calc(var(--dsh-composer-stack-gap, 6px) * -0.5)',
  marginBottom: 'calc(var(--dsh-composer-stack-gap, 6px) * -0.5)',
  pointerEvents: 'none',
},
card: {
  position: 'absolute',
  left: '50%',
  bottom: '8px',
  transform: 'translateX(-50%)',
  width: '360px',
  maxWidth: 'calc(100vw - 32px)',
  pointerEvents: 'auto',
  zIndex: 20,
}
```

- 锚点仍留在 composer stack 里，因此能拿到正确的槽位坐标；
- 卡片绝对定位、脱离文档流，不把输入框顶下去；
- 负 margin 抵消前后两个 flex gap，输入框位置保持不变；
- 主题色使用 `--dsw-alias-*` token。

### 5.4 三个动作

| 按钮 | 行为 |
|---|---|
| **加载** | `inputActions.setDraft('加载')` + `submit()`；记录 `loadedKey = path@mtimeLabel`；开始轮询 |
| **跳过** | `POST action=dismiss`，按版本忽略 |
| **归档并关闭** | 仅预览兜底路径使用：`POST action=archive` |

**加载按钮不读取正文、不拼接正文。** 输入框里只有「加载」两个字，正文由模型通过 `read` 工具读取。

### 5.5 归档确认

点击加载后客户端每 2.5 秒 `GET state`，最多 60 秒：

- `present=false` → 模型已归档，停止轮询；
- 超时仍存在 → 清空 `loadedKey`，横幅重新出现，允许重试；
- 连续请求失败 6 次 → 同样恢复横幅。

---

## 6. 模型交互（Host 原生事件）

加载指令与自动归档都跑在 Host 插件里，用 Cordis 事件实现，不经过 shell，因此不受 `workspace-write` 沙箱影响。

### 6.1 `agent/created` → 注入加载说明

会话创建（`startup` / `resume` / …）时，若当前项目存在 `HANDOFF.md`：

```js
agent.inject({
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text: buildInjectedContext(path, meta) }],
  source: { kind: 'session-continuity' },
})
```

注入内容：

```text
[待处理 HANDOFF.md]
- 路径: D:/proj/.dsh/HANDOFF.md
- 时间: ...
- 来源: 手动保存

用户说「加载」时：只用 read 工具读取该文件，把正文原样展示。
读取后插件会自动归档该文件，不要自行移动、删除或再次读取。
不要总结、不要分析、不要执行文件里的任务。
```

子代理（`delegationDepth > 0`）不注入。

### 6.2 `tools/post-execute` → read 后自动归档

`read` 工具返回后，Host 直接比较 `exec.arguments.file_path` 与当前项目的 `HANDOFF.md`：

- 命中 → `rename()` 到 `history/HANDOFF-YYYY-MM-DD-HHMMSS.md`；
- 兼容 `arguments` 为 JSON 字符串/对象，以及 Git Bash 的 `/d/...` 路径；
- 不依赖模型执行 `mv`，也不依赖 Python 进程。

### 6.3 为什么停用 Claude Code hook 桥接

`hooks/hooks.json`、`session-start.py`、`user-prompt-submit.py`、`post-tool-use.py` 仍在仓库里，但本机 profile 已 `disabled: true`。

原因：DSH 的 hook 桥接通过 `ctx.shell` 执行 `python ...`，而宿主默认权限是 `workspace-write`；Windows ACL runner 要求 temp root 位于 workspace 之外，实际 workspace 被判成用户主目录，于是每次 hook 都失败：

```text
sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host
Runner failure: windows-acl-run: Windows ACL temp root must be outside the workspace
```

表现为 `hook/invoked` + `hook/result decision=pass`，但脚本从未运行、`hook.log` 没有记录、模型收不到任何指令。

原生事件不经过 shell，是当前默认权限下的正确路径。若在 `danger-full-access` 宿主上想复用 hook，可把 profile patch 里的 `disabled: true` 去掉。

---

## 7. 安装与配置

### 7.1 bundle patch

```yaml
- insert:
    - id: session-continuity
      name: dsh-session-continuity
```

### 7.2 package.json 清单

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
  }
}
```

### 7.3 项目配置（可选）

`<project>/.dsh/session-continuity.json`：

```json
{
  "handler": "plugin",
  "handoff": {
    "promptMode": "reply",
    "staleDays": 3
  }
}
```

`handler` 不是 `plugin` 时 hook 静默退出，避免跨项目串扰。

### 7.4 save-state skill 的唯一定位

DSH 只从这些根扫描 skill（`dsh-skill-filesystem`）：

```text
<project>/.dsh/skills → <project>/.agents/skills → customSkillDirs
  → <DSH_HOME>/skills → ~/.agents/skills → bundledSkillDir
```

它**不会**扫描插件包里的 `skills/`。所以 Host 插件在每次启动（`apply`）时自动确保用户级入口存在：

```text
<DSH_HOME>/skills/save-state  →  <本包>/skills/save-state
```

- 已存在且指向本包：不动；
- 已存在但指向别处（例如旧的手工副本）：保留用户数据，只写诊断日志；
- 不存在：Windows 建 junction（`fs.symlinkSync(..., 'junction')`），其他平台建目录符号链接。

因此只维护 `plugins/dsh-session-continuity/skills/save-state/SKILL.md` 这一份，安装/升级/重启宿主后无需手工建链。需要修复时也可以手动执行：

```bat
mklink /J "%USERPROFILE%\.dsh\skills\save-state" ^
         "<插件目录>\skills\save-state"
```

---

## 8. 测试与排查

### 8.1 手工验证 Host

```bash
curl "http://localhost:3080/dsh-session-continuity/api/handoff?cwd=D%3A%5Cproj&sessionId=<id>&blank=1"
```

期望：

- 新空白会话：`present=true, relevant=true`；
- 非空白会话：`present=true, relevant=false`（或 `present=false`）；
- 已跳过/已归档：`handled=true` 或 `present=false`。

### 8.2 验证 Hook

```bash
# 归档结果
ls "<project>/.dsh/session-continuity/history"
ls "<project>/.dsh/HANDOFF.md"   # 归档后应为 No such file

# 宿主调试日志（需开启 debug）
tail -5 ~/.dsh/session-continuity-logs/<date>.log
# injected handoff instruction: .../HANDOFF.md
# read triggered archive: .../history/HANDOFF-2026-10-28-190801.md
```

### 8.3 验证客户端

先在浏览器控制台打开调试输出（默认关闭）：

```js
localStorage.setItem('dsh-session-continuity:debug', '1')
location.reload()
```

之后会看到：

```text
[session-continuity/client] state {"present":true,"relevant":true,"handled":false,...}
```

关闭：

```js
localStorage.removeItem('dsh-session-continuity:debug')
location.reload()
```

### 8.4 调试开关

Host 侧默认静默，只有 `WARN` 级（真实异常）始终输出。

在 `profiles/web/cordis.patch.yml` 覆盖插件行：

```yaml
- id: session-continuity
  config:
    debug: true
```

或者用环境变量（不改配置）：

```bash
DSH_SESSION_CONTINUITY_DEBUG=1 dsh --profile web ...
```

开启后 `~/.dsh/session-continuity-logs/<date>.log` 与控制台会记录每条请求与判定：

```text
[session-continuity] state sessionId=... blank=true present=true relevant=true handled=false
```

### 8.5 需要重启的改动

| 改动 | 生效方式 |
|---|---|
| `client.js` | 刷新页面 |
| `index.js`、`hooks.json`、profile patch | 重启 DSH host |
| `hooks/*.py` | 下一次 hook 事件自动生效（每次现起进程） |

---

## 9. 设计决策备忘

| 决策 | 原因 |
|---|---|
| 用 `blank` 而不是创建时间 | 空白会话会被复用；`createdAt` 有首帧竞态 |
| 删除 `claimedBy` 认领 | 一份 Handoff 被第一个会话认领后，之后所有新会话永久静默 |
| 跳过按 `path@mtime` 版本化 | 新 save-state 自动恢复提示；跳过不会跨版本生效 |
| 挂在 `conversation.input.dock` | `composer.dock` 只在 active 阶段渲染，新会话不可见 |
| cwd 用 `useSessions` | `inject` 结果被 renderer 缓存，列表后到时不会重算 |
| 浮层用零高度锚点 | 既拿到槽位坐标，又不占文档流，输入框不被顶动 |
| 加载只发「加载」 | 正文不经过前端；模型用 `read` 读取，日志里只留一条短消息 |
| 加载用 Host 原生事件而不是 hook 桥接 | hook 经 `ctx.shell` 执行，在 workspace-write 沙箱下会被 windows-acl-run 拒绝 |
| 归档放在 `tools/post-execute` | 读完必然归档，不依赖模型执行 `mv`，也不依赖外部进程 |

---

## 10. 已知边界

- 只在**新会话（blank）**提示；已有内容的会话不会被打断。
- Handoff 是项目级单文件；同一项目同时只保留一份待加载状态。
- 「跳过」是项目级、按版本生效，不是按会话。
- 归档由 Host 的 `tools/post-execute` 在 `read` 之后直接完成，不依赖模型执行 `mv`，也不依赖 Python/hook 进程；模型根本没有读取时，客户端 60 秒后恢复横幅供重试。
- 若宿主未暴露 `inputActions`，加载按钮退化为横幅内预览（不会丢内容）。
