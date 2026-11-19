"""Read runtime settings and update the server's private dotenv atomically."""

import json
import os
import tempfile
import threading
from pathlib import Path


PROVIDER_CONFIG = "PAW_AI_PROVIDERS_JSON"
EDITABLE = frozenset({PROVIDER_CONFIG, "TAVILY_API_KEY"})


class Environment:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()

    def _lines(self):
        if self.path.is_file():
            return self.path.read_text(encoding="utf-8-sig").splitlines()
        return []

    @staticmethod
    def _entry(line):
        key, equals, value = line.partition("=")
        if not equals or key.lstrip().startswith("#"):
            return "", ""
        key, value = key.strip(), value.strip()
        if value.startswith('"'):
            try:
                decoded = json.loads(value)
            except ValueError:
                decoded = None
            if isinstance(decoded, str):
                value = decoded
        elif len(value) >= 2 and value[0] == value[-1] == "'":
            value = value[1:-1]
        return key, value

    def values(self, allowed):
        values = dict(self._entry(line) for line in self._lines())
        return {key: os.environ.get(key, values.get(key, "")) for key in allowed}

    def get(self, key):
        return self.values((key,))[key]

    @staticmethod
    def read_only(key):
        return key in os.environ

    def set(self, key, value):
        if (
            key not in EDITABLE
            or not isinstance(value, str)
            or any(c in value for c in "\r\n\x00")
        ):
            raise ValueError("环境设置格式不正确")
        if self.read_only(key):
            raise ValueError("该项由启动环境注入，请在服务端修改")
        with self.lock:
            retained = [line for line in self._lines() if self._entry(line)[0] != key]
            if value:
                retained.append(f"{key}={json.dumps(value, ensure_ascii=False)}")
            self.path.parent.mkdir(parents=True, exist_ok=True)
            handle = tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                prefix=".env-write-",
                dir=self.path.parent,
                delete=False,
            )
            staging = Path(handle.name)
            try:
                with handle:
                    os.fchmod(handle.fileno(), 0o600)
                    handle.write("\n".join(retained) + "\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                staging.replace(self.path)
            finally:
                staging.unlink(missing_ok=True)
