"""Reviewed character meanings, aligned ruby text and context-bound dictation."""

from pathlib import Path
import hashlib, json, re, unicodedata, urllib.parse
from backend.materials.dictionary_provenance import validate_unchanged_moe_entry
from backend.materials.reviewed_audio import ReviewedAudio

SCHEMA = "banxuepaw-character-learning-v1"
ID = re.compile(r"hanzi-[a-f0-9]{4,6}")
CJK = re.compile(r"[\u3400-\u9fff\U00020000-\U0003134f]")
SYLLABLE = re.compile(r"[a-zA-ZüÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿêếề]+")
CHECKS = (
    "phoneticsApproved",
    "childMeaningApproved",
    "meaningPinyinApproved",
    "examplePinyinApproved",
    "wordPinyinApproved",
    "sourceReferencesApproved",
    "dictionaryDefinitionApproved",
)


def context_pronunciation_verified(word, tokens):
    """A neutral tone needs an exact dictionary word record, not a broad flag."""
    source = word.get("pronunciationSource", {})
    raw = source.get("originalLine", "")
    if (
        source.get("kind") != "cc-cedict-word-pronunciation"
        or not isinstance(raw, str)
        or hashlib.sha256(raw.encode()).hexdigest() != source.get("sha256")
    ):
        return False
    parsed = urllib.parse.urlsplit(source.get("url", ""))
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or source.get("license") != "CC-BY-SA-4.0"
    ):
        return False
    match = re.fullmatch(r"(\S+) (\S+) \[([^\]\r\n]+)\] /[^\r\n]+/", raw)
    if not match or word["text"] not in match.group(1, 2):
        return False
    numbered = [
        s.casefold().replace("u:", "v").replace("ü", "v") for s in match[3].split()
    ]
    expected = [tone_number(t["pinyin"]) for t in tokens if t["pinyin"]]
    return numbered == expected


def validate_meaning_source(row, character=None):
    source = row.get("meaningSource", {})
    if source.get("kind") != "dictionary-original":
        raise ValueError("字义必须来自可核对的中文辞书原义")
    for text, key in [("originalText", "textSha256"), ("displayText", "displaySha256")]:
        value = source.get(text)
        if (
            not isinstance(value, str)
            or not value.strip()
            or hashlib.sha256(value.encode()).hexdigest() != source.get(key)
        ):
            raise ValueError("辞书原义和原文校验不一致")
    if row.get("meaning") != source["displayText"] or not CJK.search(
        source["originalText"]
    ):
        raise ValueError("字义不是对应的中文辞书原文")
    url = urllib.parse.urlsplit(source.get("url", ""))
    if (
        source.get("originalRecord")
        or source.get("officialDataset")
        or source.get("license") == "CC-BY-ND-3.0-TW"
    ):
        if source.get("license") != "CC-BY-ND-3.0-TW":
            raise ValueError("不能更改原辞书记录的许可标识")
        return validate_unchanged_moe_entry(
            source, character, row.get("pinyin"), tone_number(row.get("pinyin"))
        )
    if (
        url.scheme != "https"
        or not url.hostname
        or not source.get("revision")
        or not source.get("title")
        or source.get("license")
        not in ("CC-BY-SA-4.0", "CC-BY-SA-3.0", "CC0-1.0", "public-domain")
    ):
        raise ValueError("字义来源、修订版本或使用说明未核对完整")
    if source["originalText"] != source["displayText"]:
        conversion = source.get("conversion", {})
        if (
            conversion.get("method") not in ("wikimedia-zh-cn", "opencc")
            or conversion.get("verified") is not True
        ):
            raise ValueError("简繁字形转换尚未核对，不能改写辞书释义")


def tone_number(syllable):
    if not isinstance(syllable, str) or not SYLLABLE.fullmatch(syllable):
        raise ValueError("拼音音节不正确")
    result = ""
    tone = 5
    seen = False
    for c in unicodedata.normalize("NFD", syllable.casefold()):
        if c in "\u0304\u0301\u030c\u0300":
            if seen:
                raise ValueError("同一音节有多个声调符号")
            tone = {"\u0304": 1, "\u0301": 2, "\u030c": 3, "\u0300": 4}[c]
            seen = True
        elif c == "\u0308":
            if not result.endswith("u"):
                raise ValueError("拼音声韵母不正确")
            result = result[:-1] + "v"
        elif unicodedata.combining(c):
            raise ValueError("尚未支持的拼音符号需核对")
        else:
            result += c
    return result + str(tone)


def content_hash(entry):
    value = {
        k: v
        for k, v in entry.items()
        if k not in ("review", "dictation", "contentSha256")
    }
    return hashlib.sha256(
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()


def ruby_tokens(text, pinyin):
    if (
        not isinstance(text, str)
        or not text.strip()
        or len(text) > 500
        or not isinstance(pinyin, str)
    ):
        raise ValueError("生字解释或注音不完整")
    syllables = pinyin.split()
    letters = [c for c in text if CJK.fullmatch(c)]
    if len(syllables) != len(letters) or any(
        not SYLLABLE.fullmatch(s) for s in syllables
    ):
        raise ValueError("生字解释与拼音未逐字对齐")
    iterator = iter(syllables)
    return [
        dict(text=c, pinyin=next(iterator) if CJK.fullmatch(c) else "") for c in text
    ]


def approved(entry, preview=False):
    review = entry.get("review", {})
    if entry.get("contentSha256") != content_hash(entry):
        raise ValueError("字卡内容已变更，需要重新核对")
    if preview:
        return False
    if review.get("status") != "approved" or any(
        review.get(k) is not True for k in CHECKS
    ):
        raise ValueError("这张字卡的释义和读音尚未核对完成")
    if (
        review.get("contentSha256") != entry["contentSha256"]
        or type(review.get("at")) is not int
        or not review.get("reviewers")
        or review.get("synthetic") is True
    ):
        raise ValueError("字卡缺少与当前内容一致的独立核对记录")
    return True


def public_card(identity, entry, preview=False, recordings=None):
    character = entry.get("character")
    if (
        not ID.fullmatch(identity or "")
        or not isinstance(character, str)
        or len(character) != 1
        or identity != "hanzi-" + format(ord(character), "x")
    ):
        raise ValueError("生字编号与汉字不一致")
    ready = approved(entry, preview)
    readings = []
    for row in entry.get("readings", []):
        original_source = (
            validate_meaning_source(row, character) if not preview else None
        )
        numbered = str(row.get("toneNumber", "")).replace("u:", "v").replace("ü", "v")
        if not SYLLABLE.fullmatch(row.get("pinyin", "")) or not re.fullmatch(
            r"[a-z]+[1-5]", numbered
        ):
            raise ValueError("本字读音尚待核对")
        if tone_number(row["pinyin"]) != numbered:
            raise ValueError("本字声调与数字拼音不一致")
        if "在教材词句中观察" in row.get("meaning", ""):
            raise ValueError("字义仍为占位内容")
        meaning = ruby_tokens(row.get("meaning"), row.get("meaningPinyin"))
        originals = row.get("words", [])
        words = [
            dict(
                text=w["text"],
                pinyin=w["pinyin"],
                tokens=ruby_tokens(w["text"], w["pinyin"]),
            )
            for w in originals
        ]
        if not words or any(character not in w["text"] for w in words):
            raise ValueError("本字缺少可核对的常用例词")
        for original, word in zip(originals, words):
            for token in word["tokens"]:
                if token["text"] != character:
                    continue
                context = tone_number(token["pinyin"])
                sandhi = (
                    character == "一"
                    and numbered == "yi1"
                    and context in ("yi2", "yi4")
                ) or (character == "不" and numbered == "bu4" and context == "bu2")
                neutral = context == numbered[
                    :-1
                ] + "5" and context_pronunciation_verified(original, word["tokens"])
                if context != numbered and not sandhi and not neutral:
                    raise ValueError("例词使用了本字另一个读音，需要重新核对义项")
        example = row.get("example", {})
        tokens = ruby_tokens(example.get("text"), example.get("pinyin"))
        if character not in example["text"]:
            raise ValueError("例句没有使用当前汉字")
        if ready and recordings is not None:
            for word in words:
                reference = recordings.reference(
                    word["text"],
                    word["pinyin"],
                    [tone_number(t["pinyin"]) for t in word["tokens"] if t["pinyin"]],
                )
                if reference:
                    word["audio"] = reference
        example_view = dict(
            text=example["text"], pinyin=example["pinyin"], tokens=tokens
        )
        if ready and recordings is not None:
            reference = recordings.reference(
                example["text"],
                example["pinyin"],
                [tone_number(t["pinyin"]) for t in tokens if t["pinyin"]],
            )
            if reference:
                example_view["audio"] = reference
        # Full dictionary glosses/semanticFacts/paths never cross this boundary.
        refs = [
            {
                k: r[k]
                for k in (
                    "kind",
                    "title",
                    "url",
                    "lineSha256",
                    "evidenceSha256",
                    "bookId",
                    "page",
                    "license",
                )
                if k in r
            }
            for r in row.get("sourceRefs", [])
        ]
        view = dict(
            pinyin=row["pinyin"],
            toneNumber=row["toneNumber"],
            meaning=row["meaning"],
            meaningTokens=meaning,
            words=words,
            example=example_view,
            sourceRefs=refs,
        )
        if original_source:
            view["originalDictionaryEntry"] = original_source
        readings.append(view)
    if not readings:
        raise ValueError("本字没有已准备的读音和释义")
    audio_ready = ready and all(
        all(w.get("audio") for w in r["words"]) and r["example"].get("audio")
        for r in readings
    )
    return dict(
        id=identity,
        character=character,
        readings=readings,
        ready=ready,
        dictationReady=bool(audio_ready),
        preview=preview,
        contentSha256=entry["contentSha256"],
    )


class CharacterLearning:
    def __init__(self, path, preview=False):
        self.path = Path(path)
        self.preview = preview
        self.stamp = None
        self.entries = {}
        self.recordings = ReviewedAudio(self.path.parent / "recordings")

    def _load(self):
        if not self.path.is_file():
            return {}
        if self.path.is_symlink() or self.path.stat().st_size > 32 * 1024**2:
            raise ValueError("字卡资料不能读取")
        stamp = (self.path.stat().st_mtime_ns, self.path.stat().st_size)
        if stamp != self.stamp:
            value = json.loads(self.path.read_text("utf-8"))
            if value.get("schema") != SCHEMA or not isinstance(
                value.get("entries"), dict
            ):
                raise ValueError("字卡资料版本不正确")
            self.entries = value["entries"]
            self.stamp = stamp
        return self.entries

    def item(self, identity):
        if not ID.fullmatch(identity or ""):
            raise ValueError("生字编号不正确")
        entry = self._load().get(identity)
        if entry is None:
            return None
        return public_card(identity, entry, self.preview, self.recordings)

    def dictation(self, identity, reading=0):
        card = self.item(identity)
        if not card or not card["dictationReady"]:
            raise ValueError("先完成这张字卡的听写读音核对，再加入听写")
        if type(reading) is not int or not 0 <= reading < len(card["readings"]):
            raise ValueError("请选择已核对的读音")
        row = card["readings"][reading]
        word = row["words"][0]
        return dict(
            text=word["text"],
            phonetic=word["pinyin"],
            audio=word["audio"],
            meaning=row["meaning"],
            meaningKind="character",
            meaningTokens=row["meaningTokens"],
            language="zh-CN",
            targetCharacter=card["character"],
            targetPinyin=row["pinyin"],
            characterId=identity,
            readingIndex=reading,
            source="生字总库 · 听词识字",
            contentRevision=card["contentSha256"],
            speechText=word["text"],
        )
