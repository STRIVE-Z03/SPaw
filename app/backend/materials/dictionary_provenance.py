"""Unmodified, fully attributed original dictionary entries for reviewed cards."""

import hashlib, json, re, urllib.parse

SHA = re.compile(r"[a-f0-9]{64}")
INSTRUCTIONS = {
    "國語小字典": ("2019_20260929", "minidict_10312.odt"),
    "國語辭典簡編本": ("2014_20260929", "conciseddict_10312.odt"),
    "重編國語辭典修訂本": ("2015_20260929", "reviseddict_10312.odt"),
}


def official_url(value):
    if not isinstance(value, str):
        return False
    parsed = urllib.parse.urlsplit(value)
    return (
        parsed.scheme == "https"
        and parsed.hostname is not None
        and any(
            parsed.hostname == root or parsed.hostname.endswith("." + root)
            for root in ("moe.gov.tw", "moe.edu.tw")
        )
        and not parsed.username
        and not parsed.password
    )


def valid_sha(value):
    return isinstance(value, str) and SHA.fullmatch(value) is not None


def display_definition(raw):
    # The original cell remains unchanged; only Excel's CR escape is rendered.
    return raw.replace("_x000D_", "\r")


def original_excerpt(source, full):
    """A quoted sense never replaces, rewrites or truncates the original row."""
    excerpt = source.get("originalExcerpt")
    if excerpt is None:
        if full != source.get("originalText"):
            raise ValueError("释义与原辞书记录不一致")
        return None
    if not isinstance(full, str) or not isinstance(excerpt, dict):
        raise ValueError("辞书原文引用范围不正确")
    start, end = excerpt.get("start"), excerpt.get("end")
    if (
        excerpt.get("kind") != "verbatim-original-sense"
        or excerpt.get("indexUnit") != "Unicode-codepoints"
        or type(start) is not int
        or type(end) is not int
        or not 0 <= start < end <= len(full)
    ):
        raise ValueError("辞书原文引用范围不正确")
    raw = full[start:end]
    if raw != source.get("originalText") or hashlib.sha256(
        full.encode()
    ).hexdigest() != excerpt.get("fullFieldSha256"):
        raise ValueError("辞书引用不是原始字段的完整原文片段")
    # Start at a sentence or numbered sense, never in the middle of a word.
    before = full[:start].rstrip()
    boundary = (
        not before
        or before[-1] in "。！？；\n"
        or re.search(r"(?:^|[\n。；：:])\s*(?:\d+[.、]|[（(]\d+[)）])\s*$", before)
    )
    if not boundary or raw[-1] not in "。！？；":
        raise ValueError("辞书引用应保留完整原句或义项")
    return dict(
        start=start, end=end, indexUnit="Unicode-codepoints", kind=excerpt["kind"]
    )


def validate_learning_alignment(source, headword, character, numbered, record_sha):
    """Independently sourced learning spelling/reading; original is untouched."""
    alignment = source.get("learningAlignment", {})
    evidence = alignment.get("mainlandDictionary", {})
    raw = evidence.get("originalLine")
    if (
        alignment.get("kind") != "separate-mainland-learning-headword"
        or alignment.get("originalHeadword") != headword
        or alignment.get("character") != character
        or alignment.get("toneNumber") != numbered
        or alignment.get("originalRecordSha256") != record_sha
    ):
        raise ValueError("原字形与大陆学习字音的分别对应尚未核对")
    if (
        not isinstance(raw, str)
        or hashlib.sha256(raw.encode()).hexdigest() != evidence.get("sha256")
        or evidence.get("license") != "CC-BY-SA-4.0"
        or evidence.get("url")
        != "https://www.mdbg.net/chinese/dictionary?page=cc-cedict"
    ):
        raise ValueError("大陆学习字音缺少独立原词条证据")
    match = re.fullmatch(r"(\S+) (\S+) \[([^\]\r\n]+)\] /[^\r\n]+/", raw)
    if (
        not match
        or match[1] != headword
        or match[2] != character
        or match[3].casefold().replace("u:", "v").replace("ü", "v") != numbered
    ):
        raise ValueError("学习字音或简繁对应与原词条不一致")


def validate_unchanged_moe_entry(source, character, reading, numbered=None):
    record = source.get("originalRecord", {})
    fields = record.get("fieldNames")
    values = record.get("values")
    column = record.get("definitionIndex")
    if (
        not isinstance(fields, list)
        or not isinstance(values, list)
        or not 1 <= len(fields) == len(values) <= 30
        or any(not isinstance(k, str) for k in fields)
        or len(set(fields)) != len(fields)
    ):
        raise ValueError("辞书完整原字段尚未保留")
    if type(column) is not int or not 0 <= column < len(values):
        raise ValueError("释义与原辞书记录不一致")
    excerpt = original_excerpt(source, values[column])
    digest = hashlib.sha256(
        json.dumps(
            values, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()
    if (
        digest != record.get("sha256")
        or type(record.get("row")) is not int
        or record["row"] < 2
    ):
        raise ValueError("辞书原记录校验或行号不正确")
    headword = record.get("headword")
    if (
        not isinstance(character, str)
        or not isinstance(headword, str)
        or values[0] != headword
    ):
        raise ValueError("原字头与学习汉字的对应尚未核对")
    same_head_and_reading = (
        headword == character
        and "漢語拼音" in fields
        and values[fields.index("漢語拼音")] == reading
    )
    if not same_head_and_reading:
        validate_learning_alignment(
            source, headword, character, numbered, record["sha256"]
        )
    conversion = source.get("conversion")
    raw = source["originalText"]
    if conversion:
        if conversion.get("method") != "excel-linebreak-rendering" or source.get(
            "displayText"
        ) != display_definition(raw):
            raise ValueError("此辞书原文不可转简或改写")
    elif source.get("displayText") != raw:
        raise ValueError("此辞书原文不可转简或改写")
    title = source.get("title")
    dataset = source.get("officialDataset", {})
    instruction = source.get("useInstructions", {})
    if (
        title not in INSTRUCTIONS
        or dataset.get("version") != INSTRUCTIONS[title][0]
        or source.get("revision") != dataset["version"]
        or not valid_sha(dataset.get("sha256"))
        or not official_url(dataset.get("url"))
    ):
        raise ValueError("辞书官方版本和原包证据不完整")
    if (
        not official_url(source.get("url"))
        or not official_url(instruction.get("url"))
        or instruction.get("file") != "assets/licenses/moe/" + INSTRUCTIONS[title][1]
        or not valid_sha(instruction.get("sha256"))
    ):
        raise ValueError("辞书完整使用说明尚未保留")
    if source.get("attribution") != "中華民國教育部":
        raise ValueError("辞书署名不完整")
    if not isinstance(raw, str) or any(
        t in raw for t in ["&&", "_x005F_", "<", ">", "{{", "}}"]
    ):
        raise ValueError("原辞书标记尚未完成可逆显示适配")
    return dict(
        title=title,
        version=dataset["version"],
        headword=headword,
        fields=fields,
        values=values,
        excerpt=excerpt,
        sourceUrl=source["url"],
        license="CC-BY-ND-3.0-TW",
        attribution=source["attribution"],
        instructionsUrl=instruction["url"],
        instructionsFile="/" + instruction["file"],
    )
