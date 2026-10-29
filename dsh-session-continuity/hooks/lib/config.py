"""配置加载逻辑 — 支持默认配置 + 项目级覆盖"""

import json
from pathlib import Path
from typing import Any

from .paths import get_config_path

# 插件默认配置文件路径 (相对于插件根目录)
DEFAULT_CONFIG_PATH = Path(__file__).parent.parent.parent / "config" / "default.json"

# 默认配置 (硬编码兜底)
FALLBACK_CONFIG = {
    "handler": "plugin",
    "handoff": {
        "promptMode": "reply",
        "staleDays": 3,
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    """深度合并两个字典，override 中的值覆盖 base 中的值。

    Args:
        base: 基础字典
        override: 覆盖字典

    Returns:
        dict: 合并后的字典
    """
    result = base.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _load_json_file(path: Path) -> dict:
    """加载 JSON 文件，不存在或解析失败返回空字典。

    Args:
        path: JSON 文件路径

    Returns:
        dict: 解析后的字典
    """
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, Exception):
        return {}


def load_config(cwd: str | Path | None = None) -> dict:
    """加载配置，合并默认配置和项目配置。

    优先级 (从高到低):
    1. 项目配置: .claude/session-continuity.json
    2. 插件默认配置: config/default.json
    3. 硬编码兜底配置

    Returns:
        dict: 合并后的配置
    """
    # 加载插件默认配置
    default_config = _load_json_file(DEFAULT_CONFIG_PATH)
    if not default_config:
        default_config = FALLBACK_CONFIG

    # 加载项目配置
    project_config_path = get_config_path(cwd)
    project_config = _load_json_file(project_config_path)

    # 合并配置 (项目配置覆盖默认配置)
    return _deep_merge(default_config, project_config)


def get_config_value(key_path: str, default: Any = None, cwd: str | Path | None = None) -> Any:
    """获取配置值，支持点号分隔的路径。

    Args:
        key_path: 配置路径，如 "handoff.promptMode"
        default: 默认值

    Returns:
        Any: 配置值

    Example:
        >>> get_config_value("handoff.promptMode")
        "reply"
        >>> get_config_value("context.criticalThreshold")
        0.80
    """
    config = load_config(cwd)
    keys = key_path.split(".")
    value = config
    for key in keys:
        if isinstance(value, dict):
            value = value.get(key)
        else:
            return default
        if value is None:
            return default
    return value
