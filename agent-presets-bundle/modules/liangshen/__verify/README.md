# 梁神模式修复验证脚本

这些脚本用**真实组件**验证 `liangshen` 预设的投影修复，而不是自建桩。

| 脚本 | 验证内容 |
|---|---|
| `probe.mjs` | 真实 `cordis.Context` + 真实 `SessionProjectionRegistry`：服务可达、投影注册/折叠/`dispose()`、key 隔离、插件冷启动收窄 |
| `full.mjs` | 真实技术栈上的完整生命周期：冷启动→`tool/call` 晋升→压缩重锚定→子 Agent；hint 只在晋升后发一次、resume 不重发；混合 `promoteOn` 注册出 2 个独立 unit |
| `beforeafter.mjs` | 证明原始缺陷：`session.events` 在真实 `Session` 上确实抛错；投影折叠不触碰任何被弃用的同步读取 |
| `compaction.mjs` | 压缩语义：单/多次压缩重锚定、`compactionTools` 的**追加**语义 |
| `regress-real.mjs` | 用 `~/.dsh/sessions` 下全部真实历史日志跑折叠，确认无异常、语义正确 |
| `timeline.mjs` | 从真实日志重建「锚定→失效」时间线（2026-09-24..10-16 锚定，10-19 起失效） |
| `final-proof.mjs` | **决定性证据**：取一个真实的 2026-10-19 liangshen 会话（首轮实际带 46 个工具），让修复后的插件重算同一状态 → 得到 2 个工具 |
| `drive-real-session.mjs` | **真实模型端到端**：引导真实 web profile，创建真实 liangshen 会话并跑一轮，观察 `initial tools=2` → `change tools=46` |

## 运行

需要 Node 22+（依赖内置 `node:zlib` 的 zstd 支持）。

```bash
cd modules/liangshen/__verify
node probe.mjs          # ALL REAL-COMPONENT PROBES PASSED
node full.mjs           # ALL FULL REAL-STACK PROBES PASSED
node beforeafter.mjs    # BEFORE/AFTER CONTRAST VERIFIED
node compaction.mjs     # COMPACTION PROBES PASSED
node regress-real.mjs   # 真实日志回归
node timeline.mjs       # 时间线重建
node final-proof.mjs    # PASS: 46 -> 2
node drive-real-session.mjs   # 真实模型：initial 2 -> change 46
```

每个脚本以退出码 0 表示通过，便于串成 CI。

`drive-real-session.mjs` 需要能访问 `workbuddy` 网关（web profile 的默认 provider），
且注意网关有并发限流，遇到 `429 模型繁忙` 重试即可。

## 依赖的外部包

脚本从本机 DSH 安装目录解析真实实现：

```
D:/nvm/v24.18.1/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/
  ├── cordis/                    (Context, Service)
  ├── dsh-session/               (Session)
  └── dsh-session-projection/    (SessionProjectionRegistry)
```

换机器时改脚本顶部的 `NM` 常量即可。
