# DSH 本地插件 —— 单一源目录

仓库：<https://github.com/ZH-TX3/dsh-plugins>（public）

```bash
git clone --recurse-submodules https://github.com/ZH-TX3/dsh-plugins.git D:/ds/dsh-plugins
cd D:/ds/dsh-plugins && npm run link-host
```

`D:\ds\dsh-plugins` 是**所有本地维护插件唯一的源码位置**。`~/.dsh` 只保留运行态
（sessions / storages / profiles / skills / workflows），不再存放任何插件源码。

```
D:\ds\dsh-plugins\
├─ package.json              # 只有 scripts，没有 dependencies —— 见「宿主包解析」
├─ .gitignore
├─ scripts\
│  ├─ link-host.mjs          # 把宿主 peer 包 junction 到 ./node_modules（升级后必跑）
│  └─ doctor.mjs             # 一次性自检：条目/绝对路径/junction/兼容声明
├─ dsh-forge\                # submodule → ZH-TX3/dsh-forge         （预设，非全局补丁）
├─ dsh-web-notify\           # submodule → ZH-TX3/dsh-web-notify     （web client）
├─ dsh-skill-mcp-gate\       # submodule → ZH-TX3/dsh-skill-mcp-gate（host + web client）
├─ dsh-session-continuity\   # 外层仓跟踪
├─ dsh-workflow-library\     # 外层仓跟踪
├─ agent-presets-bundle\     # 外层仓跟踪（5 个 agent 预设 patch）
├─ forks\dsh-gitbash-shell\  # 外层仓跟踪（第三方 0.42.1 + 5 处 LOCAL PATCH）
└─ forks\dsh-bash-rtk\       # 外层仓跟踪（第三方 0.1.2 + peer/engines 适配）
```

## 包清单

| 包 | 版本 | 形态 | profile 装载 | bundle 行 | 生效 |
|---|---|---|---|---|---|
| `@local/dsh-forge` | 0.2.0 | agent 预设（features/ 10 模块） | `link:` | `@local/dsh-forge` | 选了 forge 模式才挂能力 |
| `@local/dsh-web-notify` | 0.1.0 | web client（通知） | `link:` | `@local/dsh-web-notify` | 是 |
| `dsh-skill-mcp-gate` | 0.13.0 | host + web client（skill/MCP 闸门） | `link:` | `dsh-skill-mcp-gate` | 是 |
| `dsh-session-continuity` | 1.0.0-dsh.2 | host + web client + skill | `link:` | `dsh-session-continuity` | 是 |
| `@local/dsh-workflow-library` | 0.1.0 | host（`/wf-*` 命令） | `link:` | `@local/dsh-workflow-library` | 是 |
| `@local/dsh-agent-presets` | 1.0.0 | 5 个 agent 预设 | `link:` | `@local/dsh-agent-presets` | 市场里整包停用 |
| `dsh-gitbash-shell` | 0.42.1-local.1 | 第三方 fork（shell 执行器） | `file:` | `dsh-gitbash-shell` | 是 |
| `@deeptrial/dsh-bash-rtk` | 0.1.2-local.1 | 第三方 fork（仅 `wrap` 依赖） | `file:` | `@deeptrial/dsh-bash-rtk` | 作为 wrap 被 gitbash-shell 使用 |

**为什么 forks 用 `file:` 而不是 `link:`**：这两个是上游 fork，靠「重放 LOCAL PATCH」
升级，装进 profile 树里能直接从 profile 的 node_modules 解析宿主 peer；改成 `link:`
反而要依赖本目录的 junction。自研的 6 个用 `link:`，改完即生效。

## 宿主包解析（为什么不能写 devDependencies）

`link:` 装载后，插件的模块解析从**真实路径**（本目录）往上找 `node_modules`。
`dsh-workflow-library` 里 `import '@deepseek-ai/dsh-tools'` 这类语句要能解析，
而本目录没有 node_modules。

两种做法：
- ~~把宿主包装成本目录的 devDependencies~~ → 版本被锁死，dsh 升级后插件拿旧 API 打新宿主，
  报错现场完全对不上；
- **junction 指向当前运行的 host**（采用）→ `scripts/link-host.mjs` 从 `process.execPath`
  推出宿主安装根，建 4 个 junction。宿主换版本，链接自动跟着换。

```
npm run link-host     # 建/修 junction
npm run doctor        # 全量自检
```

`node_modules` 不进版本控制（里面只有 junction）。

## 升级 dsh 的 SOP

1. `node scripts/doctor.mjs` —— 升级**前**先跑一遍，确认基线是绿的。
2. 升级 dsh。
3. `node scripts/link-host.mjs` —— 重新指向新宿主（node 版本变了也要跑，路径会变）。
4. `cd profiles/web && pnpm install` —— 刷新 profile 侧的 `link:` / `file:`。
5. `node scripts/doctor.mjs` —— 应仍全绿。
6. **梯次启用**，不要一次全开（`profiles/web/cordis.patch.yml` 里的 `disabled` 行）：
   `web-notify → workflow-library → session-continuity → skill-mcp-gate → gitbash-shell → forge`
7. 每个包补 `dsh.compatibility.dshReleases` 的新版本行，否则市场/设置页标「未知」。
   现存声明：见各包 `package.json` 的 `dsh.compatibility`。
8. 快照：`profiles/web/package.json` + `pnpm-lock.yaml` + 三个内仓的 commit
   （下表）一起存档，回滚时三者必须同步。

## 各包对本机 dsh 的依赖强度（升级风险排序）

| 包 | 依赖点 | 断点 |
|---|---|---|
| `forks/dsh-gitbash-shell` | `@deepseek-ai/dsh-bash-local` / `dsh-shell` 内部、`cordis ^4.0.1`、`schemastery ^3.18.1`、5 处 LOCAL PATCH | cordis 上 5 / schemastery 上 4 / bash-local 换接口 |
| `dsh-skill-mcp-gate` | 3 个 client slot（ui-slots / ui-layout / ui-sidebar）+ runtime 影子覆盖 invocation | 静默失效（不报错、闸门不再拦） |
| `dsh-session-continuity` | `conversation.input.dock` 插槽、`UserPromptSubmit` 桥接、`webServer` 路由 | client 不注入 / 横幅不出现 |
| `dsh-forge` | features 直接挂宿主 seam（middleware / capability-protocol / host-seam） | 静默失效：选了模式没能力 |
| `dsh-workflow-library` | `serviceForAgent(ctx, agent, 'workflowEngine')` 私有 API | `/wf-*` 报「引擎不可用」 |
| `forks/dsh-bash-rtk` | peer `<0.3.0`（bash-local / bash-sandbox / shell） | **0.3.0 直接断** |
| `dsh-web-notify` | 只用公开 client 注入 + 浏览器 Notification API | 最低 |

## 基线快照（2026-10-29 迁移时）

| 包 | commit / 版本 |
|---|---|
| dsh-forge | `ef369d7`（分支 `feat/agent-mode`） |
| dsh-web-notify | `c615d77`（分支 `master`） |
| dsh-skill-mcp-gate | `4082e36`（分支 `main`） |
| 宿主 dsh | `0.2.0-rc.2`（`D:\Program Files\nodejs\node_modules\@deepseek-ai\dsh`，即 nvm 当前版本的 junction） |
| node | `v24.18.1` |

## 已知边界

- **跨盘 junction**：C: → D: 可用（pnpm 与 link-host 都验证过）。`D:\ds\dsh-plugins`
  必须是本地固定盘，不要放外接盘或 OneDrive 同步目录。
- **`~/.dsh/skills/save-state`** 是指向 `dsh-session-continuity/skills/save-state` 的
  junction，由插件 `ensureSkillLink()` 维护。搬家/换路径后要先删旧链接再重启宿主。
- **三个包是 git submodule**（`dsh-forge` / `dsh-web-notify` / `dsh-skill-mcp-gate`），
  在它们自己的目录里照常 commit + push，外层仓记录指针。克隆要带递归：
  `git clone --recurse-submodules https://github.com/ZH-TX3/dsh-plugins.git`。
  外层仓提交后如果子模块指针变了，记得一起提交。
- `~/.dsh` 已不再是 git 仓库（2026-10-29 删除）。插件改动的版本控制在**这里**；
  迁移前的历史归档为 `D:\ds\dsh-home-20261029.bundle`，回看：
  `git clone D:/ds/dsh-home-20261029.bundle /tmp/h && git -C /tmp/h log`。
- `presets/*.patch.yml` 与 `dsh-forge/cordis.patch.yml` 里的插件 spec 是
  `file:///D:/ds/dsh-plugins/...` **绝对路径**：换目录/换机必改。`doctor.mjs` 第 2 项
  会一次性列出所有失效路径。
