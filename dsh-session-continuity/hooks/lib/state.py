"""状态管理模块 — 跨 hooks 共享状态。

只保留 Handoff 流程真正需要的字段。原版的 `warned_sessions` /
`warned_sessions_early` / `insight_turns` / `session_models` 属于上下文预警与
Insight 功能，已在 DSH 版中移除（DSH 桥接层拿不到 transcript_path，
这些功能结构性不可达）。
"""

import json
import os
import uuid
from pathlib import Path

from locking import file_lock
from .paths import get_state_path

_MAX_SESSION_ENTRIES = 100


def _default_state() -> dict:
    return {"prompted_sessions": []}


def _read_state(cwd: str | Path | None = None) -> dict:
    state_path = get_state_path(cwd)
    if not state_path.exists():
        return _default_state()
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(state, dict):
            return _default_state()
    except (OSError, json.JSONDecodeError):
        return _default_state()

    defaults = _default_state()
    for key, value in defaults.items():
        if key not in state or not isinstance(state[key], type(value)):
            state[key] = value
    return state


def _write_state_unlocked(state: dict, cwd: str | Path | None = None) -> None:
    state_path = get_state_path(cwd)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = state_path.parent / f".state.{uuid.uuid4().hex}.tmp"
    try:
        temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, state_path)
    finally:
        temporary.unlink(missing_ok=True)


def _update_state(update, cwd: str | Path | None = None) -> None:
    state_path = get_state_path(cwd)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    with file_lock(state_path.parent / ".state.lock"):
        state = _read_state(cwd)
        update(state)
        _write_state_unlocked(state, cwd)


def is_session_prompted(session_id: str, cwd: str | Path | None = None) -> bool:
    return session_id in _read_state(cwd).get("prompted_sessions", [])


def mark_session_prompted(session_id: str, cwd: str | Path | None = None) -> None:
    def update(state):
        entries = state.setdefault("prompted_sessions", [])
        if session_id not in entries:
            entries.append(session_id)
            del entries[:-_MAX_SESSION_ENTRIES]

    _update_state(update, cwd)
