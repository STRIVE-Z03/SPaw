"""Vocabulary extracted from the selected textbook's own word-list pages."""

import hashlib, json, re
from pathlib import Path

HAN = r"\u4e00-\u9fff"


def extract_vocabulary(pages, subject):
    pages = [dict(p) for p in pages]
    compact = lambda text: re.sub(r"\s+", "", text)
    if subject == "chinese":
        candidates = [
            i for i, p in enumerate(pages) if "词语表" in compact(p["text"][:140])
        ]
        kind = "词语表"
        if not candidates:
            candidates = [
                i
                for i, p in enumerate(pages)
                if any(t in compact(p["text"][:100]) for t in ["写字表", "识字表"])
            ]
            kind = "生字表"
    else:

        def rows(text):
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            count = 0
            for n, line in enumerate(lines):
                if re.match(r"^\*?[A-Za-z][A-Za-z\x27’ -]{0,40}", line) and (
                    re.search("[" + HAN + "]", line)
                    or n + 1 < len(lines)
                    and re.search("[" + HAN + "]", lines[n + 1])
                ):
                    count += 1
            return count

        candidates = [
            i
            for i, p in enumerate(pages)
            if i > len(pages) * 0.45
            and rows(p["text"]) >= 3
            and "wordsineachunit" in compact(p["text"]).lower()
        ]
        if not candidates:
            candidates = [
                i
                for i, p in enumerate(pages)
                if i > len(pages) * 0.45
                and rows(p["text"]) >= 3
                and any(
                    t in compact(p["text"]).lower()
                    for t in ["wordlist", "vocabulary", "单元词汇表", "词汇表"]
                )
            ]
        if not candidates:
            candidates = [
                i
                for i, p in enumerate(pages)
                if i > len(pages) * 0.6 and rows(p["text"]) >= 8
            ]
        kind = "单元词汇"
    if not candidates:
        return dict(items=[], groups=[], sourcePages=[], kind=kind, available=False)
    start = (
        max(candidates) if subject == "chinese" and kind == "词语表" else candidates[0]
    )
    items = []
    seen = set()
    section = "全册"
    source_pages = []
    for page in pages[start : start + 12]:
        text = page["text"]
        normalized = compact(text[:320]).lower()
        if (
            items
            and any(
                t in normalized
                for t in [
                    "后记",
                    "版权页",
                    "appendix4",
                    "vocabulary",
                    "英语歌曲",
                    "录音文字稿",
                    "总词汇表",
                    "总词表",
                    "常用语表",
                    "常用表达法",
                    "thealphabet",
                ]
            )
            and not (subject == "english" and section == "全册")
        ):
            break
        count_before = len(items)
        lines = text.splitlines()
        for index, line in enumerate(lines):
            line = line.strip()
            encoded_phonetic = any(0xE000 <= ord(c) <= 0xF8FF for c in line)
            line = "".join(
                chr(ord(c) - 0xF000) if 0xF000 <= ord(c) <= 0xF07F else c for c in line
            )
            if not line or re.fullmatch(r"\d{1,3}", line):
                continue
            if subject == "chinese":
                if any(
                    t in compact(line)
                    for t in [
                        "词语表",
                        "识字表",
                        "写字表",
                        "生字表",
                        "不计入",
                        "此前已",
                        "作为生字",
                        "注释",
                    ]
                ):
                    continue
                match = re.match(r"^(\d{1,2})\s+(?=[" + HAN + r"])", line)
                if match:
                    section = "第" + match[1] + "课"
                    line = line[match.end() :]
                if line.startswith("语文园地"):
                    section = "语文园地"
                    line = line[len("语文园地") :]
                minimum = 2 if kind == "词语表" else 1
                words = re.findall(
                    r"(?<!["
                    + HAN
                    + r"])["
                    + HAN
                    + r"]{"
                    + str(minimum)
                    + r",8}(?!["
                    + HAN
                    + r"])",
                    line,
                )
                entries = [
                    dict(text=w, phonetic="", meaning="")
                    for w in words
                    if w not in ["附录", "语文园地"]
                ]
            else:
                if compact(line).lower() in [
                    "wordsineachunit",
                    "vocabulary",
                    "wordlist",
                    "appendix3",
                    "appendix4",
                ]:
                    continue
                unit = re.match(r"^Unit\s*(\d+)\b", line, re.I)
                if unit:
                    section = "Unit " + unit[1]
                    continue
                match = re.match(
                    r"^\*?\s*([A-Za-z][A-Za-z’\x27 -]{0,40}?)\s*[/／]([^/／]{1,80})[/／]\s*(.*)$",
                    line,
                )
                if match:
                    entries = [
                        dict(
                            text=match[1].strip(),
                            phonetic="/" + match[2] + "/",
                            meaning=re.sub(r"\s*p\.\s*\d+.*$", "", match[3]).strip(),
                        )
                    ]
                else:
                    match = re.match(
                        r"^\*?\s*([A-Za-z][A-Za-z’\x27 -]{0,35}?)\s+(["
                        + HAN
                        + r"].*)$",
                        line,
                    )
                    if match:
                        entries = [
                            dict(
                                text=match[1].strip(),
                                phonetic="",
                                meaning=re.sub(
                                    r"\s*p\.\s*\d+.*$", "", match[2]
                                ).strip(),
                            )
                        ]
                    elif (
                        re.fullmatch(r"\*?[A-Za-z][A-Za-z’\x27 -]{0,30}", line)
                        and index + 1 < len(lines)
                        and re.search("[" + HAN + "]", lines[index + 1])
                    ):
                        entries = [
                            dict(
                                text=line.lstrip("*").strip(),
                                phonetic="",
                                meaning=lines[index + 1].strip(),
                            )
                        ]
                    else:
                        continue
            for entry in entries:
                if subject == "english" and encoded_phonetic:
                    entry["phonetic"] = ""
                key = (section, entry["text"].lower())
                if key in seen:
                    continue
                seen.add(key)
                items.append(
                    dict(
                        **entry,
                        section=section,
                        sourcePage=page["page"],
                        language="en-GB" if subject == "english" else "zh-CN",
                    )
                )
        if len(items) > count_before:
            source_pages.append(page["page"])
        elif items and not any(
            t in normalized
            for t in ["词语表", "识字表", "写字表", "word", "vocabulary"]
        ):
            break
    groups = []
    for name in dict.fromkeys(item["section"] for item in items):
        groups.append(
            dict(id=name, title=name, count=sum(i["section"] == name for i in items))
        )
    return dict(
        items=items,
        groups=groups,
        sourcePages=source_pages,
        kind=kind,
        available=bool(items),
    )


_catalog_stamp = None
_catalog = {}
_correction_stamp = None
_corrections = {}
_hashes = {}


def textbook_vocabulary(item, path, root, page_provider):
    if item["subject"] not in ["chinese", "english"] or item["kind"] != "textbook":
        raise ValueError("请选择语文或英语课本")
    global _catalog_stamp, _catalog, _correction_stamp, _corrections
    file = Path(root) / "vocabulary-data.json"
    stamp = (
        (str(file.resolve()), file.stat().st_mtime_ns, file.stat().st_size)
        if file.exists()
        else (str(file.resolve()), 0, 0)
    )
    if stamp != _catalog_stamp:
        _catalog = (
            json.loads(file.read_text(encoding="utf-8")).get("books", {})
            if file.exists()
            else {}
        )
        _catalog_stamp = stamp
    correction_file = Path(root) / "vocabulary-corrections.json"
    correction_stamp = (
        (
            str(correction_file.resolve()),
            correction_file.stat().st_mtime_ns,
            correction_file.stat().st_size,
        )
        if correction_file.exists()
        else (str(correction_file.resolve()), 0, 0)
    )
    if correction_stamp != _correction_stamp:
        data = (
            json.loads(correction_file.read_text(encoding="utf-8"))
            if correction_file.exists()
            else {}
        )
        if data and (
            data.get("schema") != "banxuepaw-vocabulary-corrections-v1"
            or not isinstance(data.get("books"), dict)
        ):
            raise ValueError("教材词表校正资料不完整，请联系管理员核对")
        _corrections = data.get("books", {})
        _correction_stamp = correction_stamp
    source = Path(path)
    key = (str(source), source.stat().st_mtime_ns, source.stat().st_size)
    if key not in _hashes:
        with source.open("rb") as stream:
            _hashes[key] = hashlib.file_digest(stream, "sha256").hexdigest()
    cached = _catalog.get(item["id"])
    correction = _corrections.get(item["id"])
    # A verified storage transformation preserves the original vocabulary source.
    source_hash = (
        item.get("vocabularySourceSha256")
        if _hashes[key] == item.get("storageSha256")
        else _hashes[key]
    )
    if correction and correction.get("sourceSha256") == source_hash:
        result = correction
    elif correction:
        result = extract_vocabulary(page_provider(), item["subject"])
    elif cached and cached.get("sourceSha256") == source_hash:
        result = cached
    else:
        result = extract_vocabulary(page_provider(), item["subject"])
    notice = "词表来自教材内页；可点击来源页核对，点击喇叭播放对应读音。"
    if result.get("kind") == "课文词语整理":
        notice = (
            "本书未附独立词表，以下词语从课文原文整理，按来源页分组；请对照原文核对。"
        )
    if item["subject"] == "chinese":
        notice += "拼音为自动标注，多音字请结合教材核对。"
    revision = hashlib.sha256(
        json.dumps(result.get("items", []), ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()[:16]
    return {
        **result,
        "revision": revision,
        "bookId": item["id"],
        "title": item["title"],
        "grade": item["grade"],
        "term": item["term"],
        "version": item["version"],
        "subject": item["subject"],
        "notice": notice
        if result.get("available")
        else "这本课本尚未找到可可靠提取的词表，可切换教材或手动设置词语。",
    }
