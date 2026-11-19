"""Two compact Markdown books; small provenance index, bounded section reads."""

from pathlib import Path
import hashlib, html, json, re
from backend.materials.character_learning import CharacterLearning


class ChineseLibrary:
    def __init__(self, root, learning_path=None):
        self.root = Path(root) / "content/chinese"
        self._stamp = None
        self._index = {}
        self.learning = CharacterLearning(learning_path or self.root / "learning.json")

    def _load(self):
        path = self.root / "index.json"
        if not path.is_file():
            return dict(
                schema="banxuepaw-chinese-md-v1", books=[], entries=[], coverage={}
            )
        stamp = (path.stat().st_mtime_ns, path.stat().st_size)
        if stamp != self._stamp:
            if path.stat().st_size > 8 * 1024**2:
                raise ValueError("语文目录过大")
            value = json.loads(path.read_text("utf-8"))
            if value.get("schema") != "banxuepaw-chinese-md-v1":
                raise ValueError("语文资料版本不正确")
            self._index = value
            self._stamp = stamp
        return self._index

    def catalog(self):
        v = self._load()
        return dict(
            ready=bool(v["entries"]),
            books=v["books"],
            coverage=v.get("coverage", {}),
            sources=v.get("sources", []),
        )

    def items(self, kind="characters", q="", page=1):
        if kind not in ("characters", "poems"):
            raise ValueError("请选择生字或古诗文")
        if not isinstance(q, str) or len(q) > 60:
            raise ValueError("搜索内容不超过60字")
        try:
            page = max(1, int(page))
        except (TypeError, ValueError):
            raise ValueError("页码不正确") from None
        q = q.strip().casefold()
        rows = [
            v
            for v in self._load()["entries"]
            if v["kind"] == kind
            and (
                not q
                or q
                in (
                    v["title"] + " " + v.get("pinyin", "") + " " + v.get("author", "")
                ).casefold()
            )
        ]
        size = 48 if kind == "characters" else 20
        total = len(rows)
        pages = max(1, (total + size - 1) // size)
        page = min(page, pages)
        return dict(
            kind=kind,
            items=[
                {
                    k: v[k]
                    for k in ["id", "title", "kind", "pinyin", "author", "era"]
                    if k in v
                }
                for v in rows[(page - 1) * size : page * size]
            ],
            total=total,
            page=page,
            pages=pages,
        )

    def item(self, identity):
        if not isinstance(identity, str) or not re.fullmatch(
            r"(?:hanzi-[a-f0-9]{4,6}|poem-[a-f0-9]{16})", identity
        ):
            raise ValueError("语文内容编号不正确")
        row = next((v for v in self._load()["entries"] if v["id"] == identity), None)
        if not row:
            raise ValueError("这条内容尚未完成核对")
        filename = "characters.md" if row["kind"] == "characters" else "poems.md"
        file = self.root / filename
        start, length = row.get("offset"), row.get("length")
        if (
            type(start) is not int
            or type(length) is not int
            or start < 0
            or not 0 < length <= 100000
            or start + length > file.stat().st_size
        ):
            raise ValueError("语文索引需要重新整理")
        with file.open("rb") as f:
            f.seek(start)
            raw = f.read(length)
        if hashlib.sha256(raw).hexdigest() != row["sha256"]:
            raise ValueError("语文内容已更新，请重新打开目录")
        sources = row.get("sources") or [
            self._load().get("sourceRegistry", {})[v] for v in row.get("sourceIds", [])
        ]
        result = {
            **{
                k: v
                for k, v in row.items()
                if k not in ("offset", "length", "sha256", "sourceIds")
            },
            "sources": sources,
            "markdown": raw.decode("utf-8"),
        }
        if row["kind"] == "characters":
            result["learning"] = self.learning.item(identity)
            result["learningStatus"] = (
                "reviewed" if result["learning"] else "pending-dictionary-review"
            )
            # Older clients may still read markdown. Never send the former generic
            # placeholder alongside a reviewed definition or present it as a meaning.
            card = result["learning"]
            lines = ["## " + row["title"]]
            if card:
                for reading in card["readings"]:
                    lines.extend(
                        [
                            "### " + reading["pinyin"],
                            html.escape(reading["meaning"]),
                            " ".join(
                                t["pinyin"]
                                for t in reading["meaningTokens"]
                                if t["pinyin"]
                            ),
                            "例词："
                            + "；".join(
                                w["text"] + "（" + w["pinyin"] + "）"
                                for w in reading["words"]
                            ),
                            html.escape(reading["example"]["text"]),
                            reading["example"]["pinyin"],
                        ]
                    )
            else:
                lines.append("当前字义与词中读音尚未完成核对，暂未开放学习正文。")
            result["markdown"] = "\n\n".join(lines) + "\n"
        return result

    def dictation(self, identity, reading=0):
        if not any(
            v["id"] == identity and v["kind"] == "characters"
            for v in self._load()["entries"]
        ):
            raise ValueError("这个字尚未收录")
        try:
            reading = int(reading)
        except (TypeError, ValueError):
            raise ValueError("请选择已核对的读音") from None
        return self.learning.dictation(identity, reading)
