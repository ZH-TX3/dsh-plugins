"""PostToolUse hook — 模型 read 到 HANDOFF.md 后自动归档。

为什么把归档从模型手里拿走：
UserPromptSubmit 只是「指令」，模型可以选择不执行 mv，或者只读不归档。
归档是插件自己的状态迁移，不该依赖模型遵守指令。这里在 read 工具
返回之后直接移动文件，模型只需要负责读取与展示。

DSH 桥接层 payload（见 dsh-hooks-claude-code 的 postToolPayload）：
    { cwd, tool_name, tool_input, tool_use_id, tool_response, session_id, ... }
其中 tool_input 是工具参数的 JSON 字符串。
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

from handoff import consume, handoff_path, read_metadata
from lib.paths import find_project_root, get_continuity_dir, is_continuity_handler


def log(message: str, cwd: str | Path | None = None) -> None:
    try:
        log_path = get_continuity_dir(cwd) / "logs" / "hook.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with log_path.open("a", encoding="utf-8", errors="replace") as stream:
            stream.write(f"[{timestamp}] {message}\n")
    except Exception:
        pass


def input_path(tool_input) -> str:
    """从工具参数里取 file_path；兼容 JSON 字符串与对象两种形状。"""
    if isinstance(tool_input, str):
        try:
            tool_input = json.loads(tool_input)
        except json.JSONDecodeError:
            return ""
    if not isinstance(tool_input, dict):
        return ""
    value = tool_input.get("file_path") or tool_input.get("path") or ""
    return value if isinstance(value, str) else ""


_GIT_BASH_PATH = re.compile(r"^/([A-Za-z])/(.*)$")


def to_path(value: str) -> Path:
    """把 Git Bash 风格 `/d/foo` 还原成 `D:/foo`，再交给 pathlib。"""
    match = _GIT_BASH_PATH.match(value)
    if match:
        return Path(f"{match.group(1).upper()}:/{match.group(2)}")
    return Path(value)


def main() -> None:
    raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return

    cwd = data.get("cwd")
    if not is_continuity_handler(cwd=cwd):
        return
    if str(data.get("tool_name", "") or "") != "read":
        return

    target = input_path(data.get("tool_input"))
    if not target:
        return

    project_root = find_project_root(cwd)
    handoff = handoff_path(project_root)

    try:
        if to_path(target).resolve() != handoff.resolve():
            return
    except (OSError, RuntimeError):
        return

    metadata = read_metadata(handoff)
    if metadata is None or metadata.size == 0:
        return

    try:
        destination = consume(metadata)
    except Exception as error:  # 归档失败不能影响工具结果
        log(f"PostToolUse: archive failed: {error}", project_root)
        return

    log(f"PostToolUse: archived {handoff.name} -> {destination.name}", project_root)
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": (
                f"[Handoff 已归档] {destination.name}。"
                "文件已由插件移动，不要再次读取、移动或删除它。"
            ),
        },
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
