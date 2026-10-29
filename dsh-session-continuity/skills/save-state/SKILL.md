---
name: save-state
description: |
  USE WHEN: 上下文接近满、任务切换、结束当前会话前需要保存状态，以便下个 session 无缝衔接。
  DO NOT USE WHEN: 任务还在进行中且上下文充足，或只需一次性临时备忘。
user-invocable: true
---

将当前会话状态原子写入当前项目的 `.dsh/HANDOFF.md`，供下一个 session 的 SessionStart hook 检测。

## 执行步骤

1. **解析项目根**：从当前工作目录向上查找最近的 `.git` 目录；找不到就用当前工作目录本身。
   这与 DSH 的 skill 扫描算法（`findProjectRoot`）完全一致，**不要**改用 `.claude/` 或环境变量，
   否则会出现「这里写、那里找不到」的错位。所有状态和临时文件都留在该项目的 `.dsh/` 内。
2. 运行 `git status --short` 和 `git log --oneline -5` 收集当前 Git 状态（非 Git 仓库则跳过）。
3. 根据当前会话生成完整内容，使用以下模板：

```markdown
---
type: handoff
source: save-state
quality: curated
updated_at: "{ISO 8601 当前时间}"
trigger: manual-save-state
---

# Handoff — {日期时间}

## 本会话主题
{一句话描述本次 session 的核心目标}

## 完成的工作
{本次 session 完成了什么，逐条列出}

## 下一步任务
{下个 session 应优先做什么}

## 关键决策与约束
{重要决策和不能改变的约束}

## 相关文件
{本次涉及的主要文件路径}

## Git 状态
{当前分支、未提交变更摘要、最近提交}

## 注意事项
{下个 session 需要特别注意的背景或风险}
```

4. **原子写入** `.dsh/HANDOFF.md`。必须用临时文件 + `os.replace`，
   **绝不退化成普通文件覆盖**（写到一半崩溃会毁掉上一份可用状态）：

   ```bash
   python - <<'PY'
   import os, uuid
   from pathlib import Path

   target = Path(r"<项目根>/.dsh/HANDOFF.md")
   content = r"""<完整 HANDOFF 内容>"""

   target.parent.mkdir(parents=True, exist_ok=True)
   tmp = target.parent / f".handoff.{uuid.uuid4().hex}.tmp"
   try:
       tmp.write_text(content, encoding="utf-8")
       if tmp.stat().st_size == 0:
           raise ValueError("Handoff 内容不能为空")
       os.replace(tmp, target)
   finally:
       tmp.unlink(missing_ok=True)
   PY
   ```

   - 失败时保留原文件，**不得声称保存成功**。
5. 不删除旧归档，也不写入插件目录或系统临时目录。
6. 告知用户保存路径，并说明：**在同一个项目下新开会话时，会自动询问是否加载**。

## 失败处理

- 临时文件写入或原子替换失败时，不得声称保存成功；原有 `HANDOFF.md` 应保持可用。
- 本 Skill 只负责写入，不读取也不消费 Handoff。加载由用户确认后的普通对话流程处理。
