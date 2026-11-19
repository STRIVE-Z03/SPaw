"""Immutable, prebuilt pronunciations bound to the reviewed text and pinyin.

The runtime never certifies a generated voice. It only reads a separately
reviewed manifest and verifies its exact bytes, phonemes and review binding.
"""

from pathlib import Path
import hashlib, json, re

SCHEMA = "banxuepaw-reviewed-recordings-v1"
HEX = re.compile(r"[a-f0-9]{64}")
CHECKS = (
    "phoneticTextVerified",
    "engineControlVerified",
    "fileIntegrityVerified",
    "browserPlaybackVerified",
)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def supports_mandarin_only(text):
    """Reject symbols whose spoken form is not in the per-character phonemes."""
    if not isinstance(text, str) or not text.strip():
        return False
    punctuation = "，。！？；：、,.!?;:（）()“”‘’《》〈〉「」『』【】—…· "
    return all(
        c.isspace()
        or c in punctuation
        or "\u3400" <= c <= "\u9fff"
        or "\U00020000" <= c <= "\U0003134f"
        for c in text
    )


def mandarin_phones(numbered):
    result = []
    for syllable in numbered:
        if not re.fullmatch(r"[a-z]+[1-5]", syllable):
            raise ValueError("固定读音的拼音未核对完整")
        base, tone = syllable[:-1], syllable[-1]
        # Native SAPI Chinese has these documented spellings for üe.
        result.append({"lve": "lue", "nve": "nue"}.get(base, base) + " " + tone)
    return " - ".join(result)


def record_hash(record):
    return digest({k: v for k, v in record.items() if k != "review"})


class ReviewedAudio:
    def __init__(self, root):
        self.root = Path(root)
        self.stamp = None
        self.records = {}
        self.by_text = {}
        self.verified = {}

    def _load(self):
        path = self.root / "index.json"
        if not path.is_file():
            return {}
        if path.is_symlink() or path.stat().st_size > 16 * 1024**2:
            raise ValueError("固定读音目录需要核对")
        stamp = (path.stat().st_mtime_ns, path.stat().st_size)
        if stamp != self.stamp:
            value = json.loads(path.read_text("utf-8"))
            if value.get("schema") != SCHEMA or not isinstance(
                value.get("recordings"), dict
            ):
                raise ValueError("固定读音目录版本不正确")
            if any(not isinstance(v, dict) for v in value["recordings"].values()):
                raise ValueError("固定读音条目不完整")
            self.records = value["recordings"]
            self.stamp = stamp
            self.verified = {}
            self.by_text = {}
            for key, record in self.records.items():
                bindings = record.get("bindings", [])
                if (
                    not isinstance(bindings, list)
                    or len(bindings) > 1000
                    or any(
                        not isinstance(v, dict)
                        or not isinstance(v.get("text"), str)
                        or not isinstance(v.get("pinyin"), str)
                        for v in bindings
                    )
                ):
                    raise ValueError("固定读音的文字对应不完整")
                for binding in [record, *bindings]:
                    index = (
                        binding.get("text"),
                        binding.get("pinyin"),
                        record.get("language"),
                    )
                    if all(isinstance(v, str) for v in index):
                        self.by_text.setdefault(index, []).append(key)
        return self.records

    def _record(self, identity):
        if not isinstance(identity, str) or not HEX.fullmatch(identity):
            raise ValueError("固定读音编号不正确")
        record = self._load().get(identity)
        if not isinstance(record, dict):
            raise ValueError("对应的固定读音尚未准备好")
        review = record.get("review", {})
        engine = record.get("engine", {})
        if (
            review.get("status") != "approved"
            or review.get("recordSha256") != record_hash(record)
            or any(review.get(k) is not True for k in CHECKS)
            or type(review.get("at")) is not int
            or not review.get("reviewers")
            or review.get("synthetic") is True
        ):
            raise ValueError("对应的固定读音尚未完成核对")
        if (
            record.get("sha256") != identity
            or record.get("format") not in ("wav", "mp3")
            or type(record.get("bytes")) is not int
            or not 200 < record["bytes"] <= 4 * 1024**2
        ):
            raise ValueError("固定读音文件信息不正确")
        if (
            engine.get("kind") != "sapi-pron"
            or engine.get("languageId") != 2052
            or engine.get("voiceLanguage") != "804"
            or not engine.get("voice")
            or not isinstance(engine.get("phoneIds"), list)
            or not engine["phoneIds"]
            or any(type(v) is not int or v <= 0 for v in engine["phoneIds"])
        ):
            raise ValueError("固定读音的普通话音素证据不完整")
        phones = engine.get("phonemes")
        if not isinstance(phones, str) or engine.get("roundTrip") != phones:
            raise ValueError("固定读音音素没有正确往返核对")
        if (
            record.get("language") != "zh-CN"
            or not isinstance(record.get("text"), str)
            or not isinstance(record.get("pinyin"), str)
        ):
            raise ValueError("固定读音文字信息不正确")
        path = self.root / (identity + "." + record["format"])
        if (
            path.is_symlink()
            or path.resolve().parent != self.root.resolve()
            or not path.is_file()
        ):
            raise ValueError("固定读音文件缺失")
        stat = path.stat()
        stamp = (stat.st_mtime_ns, stat.st_size, stat.st_ctime_ns)
        if self.verified.get(identity) != stamp:
            if (
                stat.st_size != record["bytes"]
                or hashlib.sha256(path.read_bytes()).hexdigest() != identity
            ):
                raise ValueError("固定读音文件已变更，需要重新核对")
            self.verified[identity] = stamp
        return record, path

    def reference(self, text, pinyin, numbered):
        # The native phoneme plan contains only explicitly aligned Chinese
        # syllables. Numbers, Latin letters and operators must not disappear.
        if not supports_mandarin_only(text):
            return None
        expected = mandarin_phones(numbered)
        # A small in-memory manifest avoids thousands of metadata files.
        self._load()
        for identity in self.by_text.get((text, pinyin, "zh-CN"), []):
            try:
                record, _ = self._record(identity)
            except ValueError:
                continue
            if record["engine"]["phonemes"] != expected:
                continue
            return dict(
                url="/api/speech/recordings/" + identity,
                sha256=identity,
                language="zh-CN",
            )
        return None

    def read(self, identity):
        record, path = self._record(identity)
        data = path.read_bytes()
        # Also close the stat/read race; a changed file must never be spoken.
        if hashlib.sha256(data).hexdigest() != identity:
            raise ValueError("固定读音文件已变更，需要重新核对")
        return data, "audio/wav" if record["format"] == "wav" else "audio/mpeg"
