"""Session Continuity Plugin (DSH) - 共享库模块"""

from .paths import (
    find_project_root,
    get_dsh_dir,
    get_config_path,
    get_state_path,
    get_handoff_path,
    get_continuity_dir,
    get_log_path,
    is_continuity_handler,
)
from .config import load_config, get_config_value
from .state import (
    is_session_prompted,
    mark_session_prompted,
)

__all__ = [
    "find_project_root",
    "get_dsh_dir",
    "get_config_path",
    "get_state_path",
    "get_handoff_path",
    "get_continuity_dir",
    "get_log_path",
    "is_continuity_handler",
    "load_config",
    "get_config_value",
    "is_session_prompted",
    "mark_session_prompted",
]
