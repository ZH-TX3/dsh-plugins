# dsh-plugins

本机所有 **DeepSeek Harness（DSH）** 本地插件的单一源码目录。自研插件、本地改造的第三方 fork、以及 agent 预设，全部住在这里；`~/.dsh` 只保留运行态，不再存任何插件源码。

目标很简单：**改一个文件就该生效，不用记它在哪**。为此所有自研包都用 `link:` 装上，跨目录、跨盘、跨 profile 都不需要复制。

[![ci](https://github.com/ZH-TX3/dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/ZH-TX3/dsh-plugins/actions/workflows/ci.yml)

- 目标宿主：dsh `0.2.0-rc.2`（node ≥ 20，实测 v24.18.1）
- 详细运维手册（装载矩阵、升级 SOP、逐包依赖断点）：[`MANIFEST.md`](./MANIFEST.md)

```bash
git clone --recurse-submodules https://github.com/ZH-TX3/dsh-plugins.git D:/ds/dsh-plugins
cd D:/ds/dsh-plugins
npm run link-host     # 把宿主 peer 包 junction 到本目录（否则部分插件 import 不到）
npm run doctor        # 自检：装载条目 / 绝对路径 / junction / 兼容声明
```

装进某个 profile（示例 `web`），三种来源任选：

```bash
# 1) 本地源码（开发用，改文件即生效）
dsh plugin --profile web add link:D:/ds/dsh-plugins/dsh-skill-mcp-gate

# 2) release 里的 .tgz（锁版本、可复现、不需要本仓）
dsh plugin --profile web add https://github.com/ZH-TX3/dsh-plugins/releases/download/v0.1.0/dsh-skill-mcp-gate-0.13.1.tgz

# 3) 直接编辑 profiles/web/package.json 的 dependencies + dsh.profile.bundles，再 pnpm install
```

每个 release 都带 `manifest.json`（包名 → 版本 → 文件名 → sha256 → URL）和 `RELEASE.md`（可直接粘的 dependencies 片段）。

---

## 一、插件一览

### 宿主 / 客户端插件

| 目录 | 包名 · 版本 | 干什么 |
|---|---|---|
| `dsh-session-continuity/` | `dsh-session-continuity` 1.0.0-dsh.2 | 跨会话续接。`save-state` skill 把状态写进项目级 `.dsh/HANDOFF.md`；新开会话时输入框上方弹横幅问「要不要加载」 |
| `dsh-skill-mcp-gate/` | `dsh-skill-mcp-gate` 0.13.0 | skill / MCP 的闸门。用配置 + 设置页控制「看得见 / 调得动」，全局与项目两层覆盖，带 `/gate` 命令面 |
| `dsh-workflow-library/` | `@local/dsh-workflow-library` 0.1.0 | 把 `~/.dsh/workflows/*.workflow.js` 变成 `/wf-<name>` 命令和 `workflow_library` 工具 |
| `dsh-web-notify/` | `@local/dsh-web-notify` 0.1.0 | 对话完成时发浏览器桌面通知。标题是会话标题，点一下跳回那条对话 |

### agent 预设

| 目录 | 包名 · 版本 | 干什么 |
|---|---|---|
| `dsh-forge/` | `@local/dsh-forge` 0.2.0 | 「锻造模式」。**预设，不是全局改机**：选了这个模式，`features/` 下 10 个能力模块才挂载；不选，插件图里连一行都没有 |
| `agent-presets-bundle/` | `@local/dsh-agent-presets` 1.0.0 | 5 个预设：`router-standard` / `router-spec` / `demo-agent` / `liangshen`（梁神模式）/ `edge-agent`（边界扩展） |

**`dsh-forge` 的 10 个 feature**：`persona`（长人设整套替换 prompt）、`rules`（硬规则走 contexts）、`middleware`、`bypass-approval`、`identity-strip`、`capability-protocol`、`request-retry`、`host-seam`（不改宿主达成改宿主，默认关）、`auto-continue`、`hooks-bypass`。

它的数据层在 `dsh-forge/data/`（人设、硬规则、mods），**改文件即生效**，不用碰代码。自带两套验证：

```bash
node dsh-forge/scripts/verify.mjs      # 42 项契约
node dsh-forge/scripts/mods-check.mjs  # 5 项 mod 管线
```

### 第三方 fork

| 目录 | 包名 · 版本 | 说明 |
|---|---|---|
| `forks/dsh-gitbash-shell/` | `dsh-gitbash-shell` 0.42.1-local.1 | Windows 上给 agent 一个真的 Git Bash 工具：私有执行器实例（官方 pwsh 执行器原样保留）、MSYS 盘根路径方言统一、四个内置预设的 Git Bash 变体、侧栏终端接管可开关。带 **5 处 `LOCAL PATCH`**，升级时按标记重放 |
| `forks/dsh-bash-rtk/` | `@deeptrial/dsh-bash-rtk` 0.1.2-local.1 | rtk（Rust Token Killer）压缩工具输出省 token。本仓里只作 `wrap` 依赖被 gitbash-shell 使用，**不在 `dsh.profile.bundles` 里**，不单独加载 |

---

## 二、装载机制

同一份源码，两种装法，区别很重要：

| 装法 | 语义 | 用在哪 |
|---|---|---|
| `link:D:/ds/dsh-plugins/x` | **真软链**。改源码立刻生效，加文件也立刻可见 | 全部自研包（6 个） |
| `file:D:/ds/dsh-plugins/forks/x` | pnpm 复制/硬链进 profile 的 `node_modules`。**改源码通常不生效**，要 `pnpm install` | 两个第三方 fork |
| `https://…/releases/download/v…/x.tgz` | 从 release 装打包好的 tarball。完全脱离本仓，锁死版本 | 分发、给别人装、回滚 |

fork 为什么不用 `link:`：它们靠「重放 LOCAL PATCH」升级，装进 profile 树里能直接从 profile 的 `node_modules` 解析宿主 peer；改成 `link:` 反而多一层依赖。

一个包要真的跑起来，需要在 profile 的 `package.json` 里出现两次：

```jsonc
{
  "dependencies":      { "dsh-skill-mcp-gate": "link:D:/ds/dsh-plugins/dsh-skill-mcp-gate" },
  "dsh": { "profile": { "bundles": ["dsh-skill-mcp-gate"] } }   // ← 少了这个不会加载
}
```

`doctor.mjs` 会对「装了但不在 bundles 里」的条目报警。

---

## 三、宿主包解析（为什么 `package.json` 没有 dependencies）

`link:` 之后，插件的模块解析从**真实路径**（本目录）往上找 `node_modules`。`dsh-workflow-library` 里 `import '@deepseek-ai/dsh-tools'` 这类语句要能解析，而本目录默认没有 `node_modules`。

两种做法，选了后者：

- ~~把宿主包装成本目录的 `devDependencies`~~ → 版本被锁死，dsh 升级后插件拿旧 API 打新宿主，报错现场完全对不上；
- **junction 指向当前运行的宿主** → `npm run link-host` 从 `process.execPath` 推出宿主安装根，建 4 个 junction。宿主换版本，链接自动跟着换。

本目录的 `node_modules` 里只有 junction，不进版本控制。

---

## 四、升级 dsh

```bash
node scripts/doctor.mjs         # 1. 升级前先确认基线是绿的
#    ……升级 dsh……
node scripts/link-host.mjs      # 2. 重新指向新宿主（node 版本变了必跑）
cd ~/.dsh/profiles/web && pnpm install   # 3. 刷新 profile 侧的 link/file
node scripts/doctor.mjs         # 4. 应该仍然全绿
```

**梯次启用，不要一次全开。** 按依赖深度从小到大：

```
web-notify → workflow-library → session-continuity → skill-mcp-gate → gitbash-shell → forge
```

各包对宿主的依赖强度不同，升级时先看这张表：

| 包 | 依赖点 | 什么时候断 |
|---|---|---|
| `forks/dsh-gitbash-shell` | `dsh-bash-local` / `dsh-shell` 内部、`cordis ^4.0.1`、`schemastery ^3.18.1` | cordis 上 5 / schemastery 上 4 / bash-local 换接口 |
| `dsh-skill-mcp-gate` | 3 个 client slot + runtime 影子覆盖 invocation | **静默失效**（不报错，闸门不再拦） |
| `dsh-session-continuity` | `conversation.input.dock` 插槽、`UserPromptSubmit` 桥接、`webServer` 路由 | client 不注入、横幅不出现 |
| `dsh-forge` | features 直接挂宿主 seam | **静默失效**（选了模式没能力） |
| `dsh-workflow-library` | `serviceForAgent(ctx, agent, 'workflowEngine')` 私有 API | `/wf-*` 报「引擎不可用」 |
| `forks/dsh-bash-rtk` | peer `>=0.2.0-rc.2 <0.3.0` | **0.3.0 直接断** |
| `dsh-web-notify` | 只用公开 client 注入 + 浏览器 Notification API | 最低 |

升级后记得给各包补 `dsh.compatibility.dshReleases` 的新版本行，否则市场/设置页只显示「未知」。

---

## 五、注意事项

**路径**

- 预设子行的插件 spec 必须是**包名 + 包内路径**（`@local/dsh-forge/features/persona/index.js`），不许绝对路径或 `./` 相对路径。预设子行不走 Loader 的相对解析（baseUrl 是 profile 根），但裸包名走 profile 的 `node_modules` —— 于是 `link:` / `file:` / `.tgz` 三种装法解析到同一份代码。`scripts/check-specs.mjs` 与 `doctor.mjs` 第 2 项都会拦，CI 里也跑。
- `~/.dsh/skills/save-state` 是指向 `dsh-session-continuity/skills/save-state` 的 junction，由插件在宿主启动时维护。改路径后**先删旧链接**再重启，否则会留一条死链。
- 跨盘 junction（C: → D:）可用，但本目录必须是**本地固定盘**，别放外接盘或 OneDrive 同步目录。

**依赖**

- `link:` 的包应当**零运行时依赖**，靠 `ctx` 注入和宿主提供的能力做事。真要 `import` 宿主包，只有 `dsh-workflow-library` 那两处，靠根 junction 兜底。
- `pnpm-workspace.yaml` 里 `nodeLinker: hoisted` + `autoInstallPeers: false`：peer 不会自动装，宿主包一旦改名或拆包，报错发生在**启动期**而不是安装期，容易误判成插件 bug。

**版本控制**

- 三个包是 **submodule**（`dsh-forge` / `dsh-web-notify` / `dsh-skill-mcp-gate`）：在它们自己的目录里照常 `commit` + `push`，外层仓记指针。克隆必须带 `--recurse-submodules`。
- `dsh-forge` 目前钉在分支 `feat/agent-mode`，它的 `main` 还在后面。
- `dsh-session-continuity`、`dsh-workflow-library`、`agent-presets-bundle`、`forks/*` 直接由外层仓跟踪。

**配置**

- `profiles/web/cordis.patch.yml` 里有一批 `disabled: true` 行，是刻意关掉的（hook 桥接、skills-manager、mcp-connector 等）。排查问题时**别一把全开**，那会把「本来就没打算跑」的东西混进现场。
- 预设 patch 里可以用 `!!js process.env.X` 之类表达式（`process` 可用），`router-standard` 的 `agentsHome` 就是这么写的，默认取 `CLAUDE_CONFIG_DIR ?? %USERPROFILE%/.claude`。
- 改 `hooks.json` 这类进程级配置后必须重启宿主，热重载不覆盖。

**验证**

```bash
npm run doctor                                   # 全量自检（推荐每次动配置后跑）
node dsh-forge/scripts/verify.mjs                # 42 项
node dsh-web-notify/scripts/selftest.mjs         # 24 项
cd dsh-skill-mcp-gate && npm test                # 18 组
```

---

## 六、发布（tag 触发）

```bash
git tag v0.1.0 && git push origin v0.1.0
```

- `.github/workflows/ci.yml` —— push / PR：`lint.mjs`（语法+JSON+YAML）、`check-specs.mjs`（spec 可解析性）、`pack-all.mjs` 试打包，产物作为 artifact 留 7 天。
- `.github/workflows/release.yml` —— 打 `v*` tag：同样两道检查 → 断言工作区干净 → `pack-all.mjs` 打包 6 个第一方包 → `gh release create` 上传 `.tgz` + `manifest.json` + `RELEASE.md`。重跑同一个 tag 会用 `--clobber` 覆盖资产。

发布范围是 6 个第一方包；`forks/` 下两个是上游项目的本地补丁，版本与授权归上游，不从本仓发。

本地想验产物：`TAG=v0.1.0 node scripts/pack-all.mjs`，产物落在 `dist/`（已 gitignore）。

## 七、目录结构

```
D:\ds\dsh-plugins\
├─ package.json          # 只有 scripts，没有 dependencies（见第三节）
├─ MANIFEST.md           # 权威运维手册
├─ scripts\
│  ├─ link-host.mjs      # 宿主 peer 包 junction
│  └─ doctor.mjs         # 自检
├─ dsh-forge\            # submodule
├─ dsh-web-notify\       # submodule
├─ dsh-skill-mcp-gate\   # submodule
├─ dsh-session-continuity\
├─ dsh-workflow-library\
├─ agent-presets-bundle\
└─ forks\
   ├─ dsh-gitbash-shell\
   └─ dsh-bash-rtk\
```

每个包都是标准 DSH 插件形态：`package.json` 里声明 `dsh.bundle.patch` 指向自己的 `cordis.patch.yml`，由 Loader 在对应 profile 的组装时插入。客户端半边额外声明 `dsh.client.inject`，指明依赖哪些 client 包。
