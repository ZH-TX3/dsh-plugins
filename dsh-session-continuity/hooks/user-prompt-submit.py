"""UserPromptSubmit hook — 用户回复「加载 / 跳过」时补注入执行指令。

为什么需要它：SessionStart 只在会话创建那一刻注入一次。若用户隔了几轮才回
「加载」，或会话是 resume 恢复的（DSH 下 SessionStart 仍会跑，但用户可能
已经翻过几轮），模型手上可能已经没有那条指令了。本 hook 在用户明确表态时补一次。

相对 Claude Code 版的改进：原版用 `prompt in LOAD_TOKENS` 严格相等匹配，
用户打「加载。」「好，加载」都会漏。这里改成**短消息 + 包含关键词**的容错匹配。
"""

import io
import json
import re
import sys
from datetime import datetime
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
HOOKS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS_DIR))

from handoff import handoff_path, read_metadata
from lib.paths import find_project_root, get_continuity_dir, is_continuity_handler

LOAD_TOKENS = ("加载", "载入", "读取", "load", "yes", "y")
SKIP_TOKENS = ("跳过", "不加载", "不用", "别读", "skip", "no", "n")

# 只有"短消息"才当作对 Handoff 的表态，避免长句里偶然出现「加载」被误判
MAX_INTENT_LENGTH = 20


def log(message: str, cwd: str | Path | None = None) -> None:
    try:
        log_path = get_continuity_dir(cwd) / "logs" / "hook.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with log_path.open("a", encoding="utf-8", errors="replace") as stream:
            stream.write(f"[{timestamp}] {message}\n")
    except Exception:
        pass


def classify_intent(prompt: str) -> str | None:
    """把用户消息归类为 load / skip / None。

    先判 skip：「不加载」「别读」里也含「加载」「读」，顺序错了会误判成 load。
    """
    text = prompt.strip().lower()
    if not text or len(text) > MAX_INTENT_LENGTH:
        return None

    # 用词边界匹配 latin token，避免 "no" 命中 "node"、"y" 命中任意单词
    def has(token: str) -> bool:
        if token.isascii():
            return re.search(rf"(?<![a-z]){re.escape(token)}(?![a-z])", text) is not None
        return token in text

    if any(has(token) for token in SKIP_TOKENS):
        return "skip"
    if any(has(token) for token in LOAD_TOKENS):
        return "load"
    return None


def main() -> None:
    raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as error:
        log(f"UserPromptSubmit: malformed payload ignored: {error}")
        return

    cwd = data.get("cwd")
    if not is_continuity_handler(cwd=cwd):
        return

    project_root = find_project_root(cwd)

    action = classify_intent(str(data.get("prompt", "") or ""))
    if action is None:
        return

    path = handoff_path(project_root)
    metadata = read_metadata(path) if path.exists() else None
    if metadata is None or metadata.size == 0:
        return

    if action == "load":
        # 归档由 PostToolUse hook 在 read 之后完成；模型只负责读取与展示。
        # 这样模型少一次工具调用，也不会因为「忘了 mv」把文件留在原地。
        src = metadata.path.as_posix()
        context = (
            "[Handoff 加载 — 只执行，不分析]\n"
            f"1. 调用 read 工具读取：{src}\n"
            "2. 把文件正文原样放进回复，不要总结、不要评价、不要读其他文件、"
            "不要执行文件里的任务。\n"
            "读取后插件会自动归档该文件，不要自行移动、删除或再次读取它。\n"
            "除 read 外不要调用任何工具。完成后只回复一句「Handoff 已加载」。"
        )
    else:
        context = (
            "[Handoff 跳过]\n"
            f"- 路径: {metadata.path}\n\n"
            "用户选择跳过 Handoff。不得读取该文件正文，继续处理用户原始需求。"
        )

    log(f"UserPromptSubmit: handoff {action} intent detected", project_root)
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context,
        },
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
