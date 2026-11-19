"""Kernel-owned per-request locks shared by web and offline generators."""

from contextlib import contextmanager
from pathlib import Path
import hashlib, os


class GenerationBusy(ValueError):
    pass


@contextmanager
def database_request_lock(db, request):
    with db() as conn:
        rows = conn.execute("PRAGMA database_list").fetchall()
        filename = next((row[2] for row in rows if row[1] == "main"), "")
    # A private in-memory database cannot be shared by separate processes.
    if not filename:
        yield
        return
    database = Path(filename).resolve()
    directory = database.parent / ("." + database.name + "-generation-locks")
    if directory.is_symlink():
        raise ValueError("生成任务锁目录不正确")
    directory.mkdir(mode=0o700, exist_ok=True)
    path = directory / (
        hashlib.sha256(str(request).encode("utf-8")).hexdigest() + ".lock"
    )
    if path.is_symlink():
        raise ValueError("生成任务锁文件不正确")
    stream = path.open("a+b")
    locked = False
    try:
        if os.name == "nt":
            import msvcrt

            if path.stat().st_size == 0:
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise GenerationBusy(
                    "这套题正在另一任务中复核，请稍后继续原任务。"
                ) from error
        else:
            import fcntl

            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise GenerationBusy(
                    "这套题正在另一任务中复核，请稍后继续原任务。"
                ) from error
        locked = True
        yield
    finally:
        if locked:
            if os.name == "nt":
                import msvcrt

                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()
        # Keep the tiny lock file: unlinking it could split waiters across two
        # inodes. The kernel releases ownership when a process exits or crashes.
