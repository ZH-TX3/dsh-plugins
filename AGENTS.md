# AGENTS.md — dsh-plugins（主仓库）

DSH 插件的集合，每个插件是独立仓库、在这里注册成 submodule。

```
dsh-forge            → https://github.com/ZH-TX3/dsh-forge.git        (feat/agent-mode)
dsh-web-notify       → https://github.com/ZH-TX3/dsh-web-notify.git   (master)
dsh-skill-mcp-gate   → https://github.com/ZH-TX3/dsh-skill-mcp-gate.git (main)
```

## 提交：必须同时更新主仓库

插件是 submodule，**只推插件仓库不算更新完成**：主仓库里记录的是那个 commit 的指针（gitlink），
指针不动，clone 主仓库的人拿到的还是旧代码。

统一用根目录的 `sync.sh`，不要手敲「推插件 → 回主仓库 add → 再推」两步：

```bash
cd D:/ds/dsh-plugins
./sync.sh "feat(panel): 本次改了什么"              # 只处理有改动的子模块
./sync.sh "fix(mcp): ..." dsh-skill-mcp-gate       # 只处理指定子模块
```

它依次做：主仓库 `pull --rebase --autostash` → 各子模块 `pull --rebase` → `add -A` → `commit` → `push`
→ 回主仓库 `add <子模块>` → `commit`（指针）→ `push`。子模块 push 失败会立刻停，不会留下半套状态。

主仓库里**子模块之外**的改动（脚本、`.gitattributes`、这份文档）脚本不替你提交，只提示，需要自己 `git add`。
`*.sh` 用 `.gitattributes` 固定为 LF —— CRLF 会让 Git Bash 报 `command not found`。

## 各插件自己的规矩

看各自目录下的 `AGENTS.md` / `README.md`，例如 `dsh-skill-mcp-gate/AGENTS.md`。
提交前在对应插件里跑一遍它自己的测试。
