"""路径查找逻辑 — 与 DSH skill-filesystem 保持完全一致的 projectRoot 算法。

DSH 的 skill 扫描根是 `<projectRoot>/.dsh/skills`，其中 projectRoot 由
`findProjectRoot(cwd)` 决定：**从 cwd 向上找最近的 `.git` 目录，找不到则回退到 cwd 本身**。

hook 必须用同一套算法，否则会出现「skill 写到 A 目录、hook 去 B 目录找」的错位。
（本文件刻意不依赖 `.claude/`，因为 DSH 项目默认没有该目录。）
"""

import os
from pathlib import Path

STATE_DIR_NAME = ".dsh"


def find_project_root(cwd: str | Path | None = None) -> Path:
    """复刻 DSH `findProjectRoot`：向上找最近的 `.git`，找不到回退到起始目录。

    与 DSH 的唯一差别：本函数永不抛异常。hook 是旁路进程，
    定位失败时必须静默降级而不是让会话报错。
    """
    current = Path(cwd) if cwd else Path.cwd()
    try:
        current = current.resolve()
    except (OSError, RuntimeError):
        current = Path(cwd) if cwd else Path.cwd()
    if current.is_file():
        current = current.parent

    start = current
    while True:
        if (current / ".git").exists():
            return current
        parent = current.parent
        if parent == current:
            return start
        current = parent


def get_dsh_dir(cwd: str | Path | None = None) -> Path:
    """项目级 `.dsh` 目录。"""
    return find_project_root(cwd) / STATE_DIR_NAME


def get_continuity_dir(cwd: str | Path | None = None) -> Path:
    return get_dsh_dir(cwd) / "session-continuity"


def get_config_path(cwd: str | Path | None = None) -> Path:
    return get_dsh_dir(cwd) / "session-continuity.json"


def get_state_path(cwd: str | Path | None = None) -> Path:
    return get_continuity_dir(cwd) / "state.json"


def get_handoff_path(cwd: str | Path | None = None) -> Path:
    return get_dsh_dir(cwd) / "HANDOFF.md"


def get_log_path(cwd: str | Path | None = None) -> Path:
    log_dir = get_continuity_dir(cwd) / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / "hook.log"


def is_continuity_handler(handler: str = "plugin", cwd: str | Path | None = None) -> bool:
    """处理器归属只读当前项目配置，避免跨项目串扰。

    注意：定位失败时 `get_config_path` 会回退到 cwd，不会抛异常，
    因此本函数在任意目录下都是安全的。
    """
    import json

    config_path = get_config_path(cwd)
    owner = "plugin"
    try:
        if config_path.exists():
            config = json.loads(config_path.read_text(encoding="utf-8"))
            owner = str(config.get("handler", owner)).strip().lower()
    except (OSError, ValueError):
        pass
    return owner == handler
