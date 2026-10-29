"""Handoff 文件操作。"""

import os
import sys
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from locking import file_lock
from lib.paths import get_dsh_dir

_FRONTMATTER_RE = re.compile(r"\A---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n|\Z)", re.DOTALL)
_VALID_SOURCES = {"save-state", "legacy"}


@dataclass(frozen=True)
class HandoffMetadata:
    path: Path
    source: str
    quality: str
    updated_at: str
    mtime: float
    size: int
    inode: int | None


def handoff_path(cwd: str | Path | None = None) -> Path:
    return get_dsh_dir(cwd) / "HANDOFF.md"


def _parse_frontmatter(text: str) -> dict[str, str]:
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return {}

    metadata = {}
    for line in match.group(1).splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        metadata[key.strip()] = value.strip().strip("\"'")
    return metadata


def read_metadata(path: Path) -> HandoffMetadata | None:
    """只读取 frontmatter 和文件 stat，确认前绝不读取正文。"""
    try:
        stat = path.stat()
        with path.open("r", encoding="utf-8", errors="replace") as stream:
            first_line = stream.readline()
            frontmatter = first_line
            if first_line.strip() == "---":
                for _ in range(64):
                    line = stream.readline()
                    frontmatter += line
                    if not line or line.strip() == "---":
                        break
    except (OSError, UnicodeError):
        return None

    metadata = _parse_frontmatter(frontmatter)
    source = metadata.get("source", "legacy")
    if source not in _VALID_SOURCES:
        source = "legacy"
    quality = metadata.get("quality", "unknown") if source != "legacy" else "unknown"
    return HandoffMetadata(
        path=path,
        source=source,
        quality=quality,
        updated_at=metadata.get("updated_at", ""),
        mtime=stat.st_mtime,
        size=stat.st_size,
        inode=getattr(stat, "st_ino", None),
    )


def atomic_write(content: str, path: Path | None = None) -> Path:
    """在项目锁内，通过唯一临时文件原子替换正式 Handoff。"""
    target = path or handoff_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = target.parent / ".handoff.lock"
    with file_lock(lock_path):
        temporary = target.parent / f".handoff.{uuid.uuid4().hex}.tmp"
        try:
            temporary.write_text(content, encoding="utf-8")
            if temporary.stat().st_size == 0:
                raise ValueError("Handoff 内容不能为空")
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    return target


def consume(expected: HandoffMetadata, now: datetime | None = None) -> Path:
    """归档已确认的 Handoff；文件在确认后变化则拒绝消费新版本。"""
    source_path = expected.path
    history_dir = source_path.parent / "session-continuity" / "history"
    lock_path = source_path.parent / ".handoff.lock"
    with file_lock(lock_path):
        current = read_metadata(source_path)
        if current is None or current.size == 0:
            raise FileNotFoundError(f"Handoff 不存在或为空: {source_path}")
        if current.mtime != expected.mtime or current.size != expected.size or current.inode != expected.inode:
            raise RuntimeError("Handoff 已在确认后更新；为保护新状态，未消费文件")

        history_dir.mkdir(parents=True, exist_ok=True)
        timestamp = (now or datetime.now()).strftime("%Y-%m-%d-%H%M%S")
        base_name = f"HANDOFF-{timestamp}"
        destination = history_dir / f"{base_name}.md"
        suffix = 1
        while destination.exists():
            destination = history_dir / f"{base_name}-{suffix}.md"
            suffix += 1

        os.replace(source_path, destination)
        archives = sorted(history_dir.glob("*HANDOFF*.md"), key=lambda item: item.stat().st_mtime)
        for old_archive in archives[:-10]:
            old_archive.unlink(missing_ok=True)
    return destination
