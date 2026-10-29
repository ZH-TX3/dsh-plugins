"""SessionStart hook — 检测 Handoff，向模型注入「加载 / 跳过」指令。

DSH 侧时序（已源码验证）：新建会话时 `agents.create()` → `agent/created`，
桥接层 awaited 本 hook 并 `agent.inject(additionalContext)`，
内容进入下一次 `agent/pre-step`，即**用户第一句话那一轮**。

因此注入能赶上第一句话，不需要用户先说什么。

关键差异（相对 Claude Code 版）：
- `INJECT_SOURCES` 加入 `resume`。DSH 实测只会发 `startup`（新建）与 `resume`（恢复），
  没有 `clear` / `compact` 发射点。若只认 `startup`，resume 会话会静默跳过。
- 定位项目根改用 DSH 的 `.git` 算法（见 lib/paths.py），不再依赖 `.claude/`。
- 输出以 `hookSpecificOutput.additionalContext` 为准；`systemMessage` 在 DSH 桥接层
  只会被记一条 warn 然后丢弃，因此不再作为主要通道。
"""

import io
import json
import sys
from datetime import datetime
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
HOOKS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS_DIR))

from handoff import handoff_path, read_metadata
from lib.config import get_config_value
from lib.paths import find_project_root, get_continuity_dir, is_continuity_handler
from lib.state import is_session_prompted, mark_session_prompted

# DSH 实测只会发 startup / resume。clear / compact 保留兼容（万一将来发射）。
INJECT_SOURCES = {"startup", "resume", "clear", "compact"}


def log(message: str, cwd: str | Path | None = None) -> None:
    try:
        log_path = get_continuity_dir(cwd) / "logs" / "hook.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with log_path.open("a", encoding="utf-8", errors="replace") as stream:
            stream.write(f"[{timestamp}] {message}\n")
    except Exception:
        pass


def relative_time(mtime: float) -> str:
    delta = max(0, datetime.now().timestamp() - mtime)
    if delta < 60:
        return f"{int(delta)} 秒前"
    if delta < 3600:
        return f"约 {int(delta // 60)} 分钟前"
    if delta < 86400:
        return f"约 {int(delta // 3600)} 小时前"
    return f"约 {int(delta // 86400)} 天前"


def build_handoff_message(metadata, mode: str) -> tuple[str, str]:
    """返回 (给用户看的提示, 给模型看的指令)。"""
    mtime = datetime.fromtimestamp(metadata.mtime).strftime("%Y-%m-%d %H:%M")
    relative = relative_time(metadata.mtime)
    source_label = "手动保存" if metadata.source == "save-state" else "旧版格式"
    details = f"- 时间：{mtime}（{relative}）\n- 来源：{source_label}\n- 大小：{metadata.size} bytes"

    if mode == "ask-user-question":
        message = f"检测到待加载的 Handoff：\n{details}\n\n请选择加载或跳过。"
        instruction = (
            "用 ask_user_question 工具询问用户是否加载 Handoff。"
            "若用户选择加载，只用 read 工具读取该 HANDOFF.md 并原样展示；"
            "读取后插件会自动归档该文件，不要自行移动、删除或再次读取。"
            "若选择跳过，不得读取正文，继续处理用户原始消息。"
        )
    else:
        message = f"检测到待加载的 Handoff：\n{details}\n\n请回复「加载」或「跳过」。"
        instruction = (
            "用户回复加载/载入/load/yes/y 时：只用 read 工具读取该 HANDOFF.md，"
            "把正文原样展示；读取后插件会自动归档该文件，不要自行移动、删除或再次读取。"
            "不要总结、不要分析、不要执行文件里的任务、不要调用其他工具。"
            "用户回复跳过/不加载/skip/no/n 时，不得读取正文，继续当前会话。"
        )

    context = (
        "[待处理 HANDOFF.md]\n"
        f"- 路径: {metadata.path}\n"
        f"- 时间: {mtime}（{relative}）\n"
        f"- 来源: {metadata.source}\n"
        f"- 交互模式: {mode}\n\n"
        f"{instruction} 加载后只恢复状态，不自动执行旧任务。\n"
        "在用户明确回复之前，不要主动读取该文件正文。"
    )
    return message, context


def main() -> None:
    raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as error:
        log(f"SessionStart: malformed payload ignored: {error}")
        return

    cwd = data.get("cwd")
    if not is_continuity_handler(cwd=cwd):
        log("SessionStart: plugin handler disabled", cwd)
        return

    project_root = find_project_root(cwd)

    session_id = str(data.get("session_id", "") or "")
    source = str(data.get("source", "unknown") or "unknown")

    if source not in INJECT_SOURCES:
        log(f"SessionStart: source={source}, silent", project_root)
        return

    path = handoff_path(project_root)
    if not path.exists():
        log(f"SessionStart: no handoff at {path}", project_root)
        return

    metadata = read_metadata(path)
    if metadata is None or metadata.size == 0:
        log("SessionStart: handoff missing or empty", project_root)
        return

    if session_id and is_session_prompted(session_id, project_root):
        log(f"SessionStart: session {session_id} already prompted", project_root)
        return

    stale_seconds = get_config_value("handoff.staleDays", 3, project_root) * 86400
    age_seconds = datetime.now().timestamp() - metadata.mtime

    if age_seconds > stale_seconds:
        stale_days = int(age_seconds // 86400)
        context = (
            f"[陈旧 HANDOFF.md]\n- 路径: {metadata.path}\n- 距今天数: {stale_days}\n\n"
            "该 Handoff 已超过 handoff.staleDays，默认忽略。"
            "仅当用户明确要求加载时，才用 read 读取该文件并原样展示；"
            "读取后插件会自动归档，不要自行移动。否则不得读取正文。"
        )
    else:
        configured = get_config_value("handoff.promptMode", "reply", project_root)
        mode = "ask-user-question" if configured in {"ask", "ask-user-question"} else "reply"
        _, context = build_handoff_message(metadata, mode)

    if session_id:
        mark_session_prompted(session_id, project_root)

    log(f"SessionStart: injected handoff prompt (source={source})", project_root)
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context,
        },
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
