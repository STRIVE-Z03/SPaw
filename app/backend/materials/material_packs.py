"""Published scan packs are file-based and restricted to the material admin."""

import json
import re

PACK_ID = re.compile(r"[a-f0-9]{16}")
FILES = {
    "pdf": ("reader.pdf", "application/pdf"),
    "bundle": ("markdown.zip", "application/zip"),
}


def pack_index(root):
    if not root.is_dir():
        return []
    result = []
    for directory in sorted(root.iterdir()):
        if not PACK_ID.fullmatch(directory.name) or not directory.is_dir():
            continue
        path = directory / "index.json"
        if not path.is_file() or path.stat().st_size > 8 * 1024**2:
            continue
        try:
            info = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(info, dict) and info.get("id") == directory.name:
            result.append(
                {
                    key: info.get(key)
                    for key in ("id", "title", "source", "kind", "count", "reviewed")
                }
            )
    return result


def pack_download(root, identity, kind):
    if not PACK_ID.fullmatch(identity) or kind not in FILES:
        raise ValueError("资料编号不正确")
    name, mime = FILES[kind]
    path = root / identity / name
    if not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("没有找到这份整理资料")
    return path, mime
