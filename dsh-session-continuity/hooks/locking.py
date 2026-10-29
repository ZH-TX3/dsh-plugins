"""跨进程文件锁。"""

import os
import time
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def file_lock(path: Path, timeout: float = 5.0):
    """用排他创建锁文件串行化短时项目状态操作。"""
    deadline = time.monotonic() + timeout
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = None
    while descriptor is None:
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                if time.time() - path.stat().st_mtime > timeout * 2:
                    path.unlink(missing_ok=True)
                    continue
            except OSError:
                pass
            if time.monotonic() >= deadline:
                raise TimeoutError(f"获取文件锁超时: {path}")
            time.sleep(0.02)

    try:
        os.write(descriptor, str(os.getpid()).encode("ascii"))
        yield
    finally:
        os.close(descriptor)
        path.unlink(missing_ok=True)
