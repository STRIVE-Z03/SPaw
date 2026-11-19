"""Traceable question regions, conservative answer checks and bounded hint anchors."""

import ast, hashlib, json, re, unicodedata
from fractions import Fraction


def tidy(text):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(text))).strip()


def practice_group(question, subject):
    """Only explicit narrow task instructions qualify; generic choice type never does."""
    if question.get("segmented") is False or question.get("retired"):
        return None
    text = tidy(question.get("stem", ""))
    head = text[:180]
    rules = {
        "math": [
            (r"用竖式|列竖式", "竖式计算"),
            (r"脱式计算|递等式|混合运算.*计算", "脱式计算"),
            (r"口算|直接写出得数", "口算"),
            (
                r"平均分.*(?:每[人份组]|每个).*多少|平均分给.*(?:每人|每个).*几",
                "平均分·求每份数量",
            ),
        ],
        "chinese": [
            (r"看拼音.{0,6}写(?:词语|汉字|生字)", "看拼音写词语"),
            (
                r"给.{0,12}(?:加点字|加点的字).{0,8}(?:选择|选出).{0,6}(?:读音|音节)",
                "辨别加点字读音",
            ),
        ],
        "english": [
            (r"选出.{0,8}不同类|choose the odd", "辨别不同类单词"),
            (
                r"根据(?:中文|汉语).{0,8}(?:写出|填写).{0,6}(?:单词|英语)",
                "根据汉语写单词",
            ),
        ],
    }
    for pattern, label in rules.get(subject, []):
        if re.search(pattern, head, re.I):
            if subject == "math" and label in ["竖式计算", "脱式计算", "口算"]:
                if not re.match(
                    r"^(?:[0-9一二三四五六七八九十]+[.、\s]*)?(?:用竖式|列竖式|脱式计算|递等式|口算|直接写出得数)",
                    head,
                ):
                    return None
                ops = "".join(
                    op
                    for op, pattern in [
                        ("加", r"\+"),
                        ("减", r"[-−]"),
                        ("乘", r"[×*]"),
                        ("除", r"[÷/]"),
                    ]
                    if re.search(pattern, text)
                )
                if not ops:
                    return None
                domain = (
                    "分数"
                    if re.search(r"\d/\d", text)
                    else "小数"
                    if re.search(r"\d\.\d", text)
                    else "整数"
                )
                label += "·" + domain + ops
            return dict(
                key=hashlib.sha256(
                    (
                        question.get("chapterId", "")
                        + ":"
                        + question.get("type", "")
                        + ":"
                        + label
                    ).encode()
                ).hexdigest()[:20],
                label=label,
                basis="按本章题目中的明确指令归类",
            )
    return None


def front_matter(lines, page):
    text = "\n".join(l["text"] for l in lines)
    if (
        page <= 14
        and len(re.findall(r"第\s*[一二三四五六七八九十0-9\s]{0,5}天", text)) >= 4
    ):
        return "contents"
    if page <= 8 and re.search(
        r"伴读打卡|亮点说明|国际阅读素养评估体系|推荐书目|小学生小古诗.*亮点", text
    ):
        return "cover-or-promotion"
    question_commands = re.search(
        r"根据.{0,8}(?:短文|文章|儿歌)|选择(?:正确|合适)|填一填|填空|请你|按要求|算一算|回答(?:问题|下列)|看图|画一画|下面(?:各题|物体|哪)|解答",
        text,
    )
    if (
        page <= 12
        and len(
            re.findall(
                r"第[一二三四五六七八九十]+单元|期[中末].{0,8}(?:卷|达标|提优)|专项突破|能力提优[（(]",
                text,
            )
        )
        >= 6
    ):
        return "contents"
    if page <= 14 and not question_commands:
        if len(re.findall(r"期末|质量检测|素养监测|学业评估|等级评价|难度", text)) >= 5:
            return "contents"
        if re.search(r"(?:^|\n)\s*(?:目录|索引|CONTENTS)\s*(?:\n|$)", text, re.I):
            return "contents"
    if page <= 8 and re.search(r"ISBN|出版发行|责任编辑|图书在版编目", text, re.I):
        return "cover-or-promotion"
    if (
        page <= 8
        and re.search(
            r"扫码(?:参与|获取|领取|下载)|研究院编|出版社|定价|编著", text, re.I
        )
        and not question_commands
        and not re.search(r"[?？]", text)
    ):
        return "cover-or-promotion"
    return None


def reading_heading(lines, height, titles=None):
    candidates = []
    # Short title characters may be separate OCR columns, especially in grade-one books.
    merged = list(lines)
    for line in lines:
        if (
            not re.fullmatch(r"[\u3400-\u9fff]", line["text"].strip())
            or line["box"][1] > height * 0.28
        ):
            continue
        near = [
            v
            for v in lines
            if re.fullmatch(r"[\u3400-\u9fff]", v["text"].strip())
            and abs(v["box"][1] - line["box"][1])
            < max(15, (line["box"][3] - line["box"][1]) * 0.4)
            and abs(v["box"][0] - line["box"][0]) < height * 0.22
        ]
        if 2 <= len(near) <= 8:
            near = sorted(near, key=lambda v: v["box"][0])
            merged.append(
                dict(
                    text="".join(v["text"].strip() for v in near),
                    box=[
                        min(v["box"][0] for v in near),
                        min(v["box"][1] for v in near),
                        max(v["box"][2] for v in near),
                        max(v["box"][3] for v in near),
                    ],
                )
            )
    for line in merged:
        if line["box"][1] > height * 0.28:
            continue
        text = tidy(line["text"])
        text = re.sub(
            r"^(?:\d{1,3}[.、·\s]*|第[一二三四五六七八九十\d]+[课篇讲]\s*)", "", text
        ).strip("=—· @①②③④⑤⑥⑦⑧⑨⑩")
        text = re.split(r"\s*[/／（(]\s*", text)[0].strip()
        if not re.fullmatch(r"[\u3400-\u9fff“”《》、]{2,16}", text):
            continue
        if re.search(
            r"年级|语文|目录|专题|得分|阅读|建议|质量|检测|难度|根据|短文|连一连|填空|写一写|编著|出版社|省|市|县|监测|展示|素养|学科|原文|译文|注释|第一|视频|音频|囗|亠|丷|乊|巛|讠|冫",
            text,
        ):
            continue
        words = line.get("words", [])
        font = max(
            (w.get("height", 0) for w in words), default=line["box"][3] - line["box"][1]
        )
        numbered = bool(re.match(r"^\s*\d+\s*[^\d]", line["text"]))
        if titles and text not in titles and not numbered:
            continue
        if not numbered and (line["box"][1] > height * 0.26 or font < height * 0.017):
            continue
        score = font + (40 if numbered else 0)
        candidates.append((score, text))
    return max(candidates, default=(0, None))[1]


def options_in(text):
    matches = list(re.finditer(r"(?:^|[\s\n])([A-D])[.．、:：)）]\s*", text))
    if len(matches) < 2 or [m[1] for m in matches] != list("ABCD")[: len(matches)]:
        return []
    result = []
    for i, m in enumerate(matches):
        value = tidy(
            text[
                m.end() : matches[i + 1].start() if i + 1 < len(matches) else len(text)
            ]
        )
        if not value or len(value) > 300:
            return []
        result.append(dict(id=m[1], text=value))
    return result


def number_marker(line):
    text = tidy(line["text"])
    match = re.match(r"^([1-9]\d?)[.、．·]\s*", text)
    if match:
        return int(match[1]), "main"
    match = re.match(r"^\(([1-9]\d?)\)", text)
    if match:
        return int(match[1]), "sub"
    # Isolated numbers are often folios or arithmetic operands, not reliable labels.
    if re.fullmatch(r"[1-9]\d?", text):
        return None
    words = line.get("words", [])
    if words and re.fullmatch(r"[1-9]\d?", words[0].get("text", "")):
        rest = "".join(w.get("text", "") for w in words[1:])
        if rest and re.match(
            r"(?:岁|厘米|分米|千米|毫米|千克|分钟|小时|米|克|元|角|分|个|只|本|颗|件|盒|块|倍|人|天|年|月|日|%|％)",
            rest,
        ):
            return None
        if rest and re.match(r"[\u3400-\u9fff（(]", rest):
            return int(words[0]["text"]), "main"
    return None


def regions(unit, lines, box, subject):
    """Split numbered source questions without throwing away unnumbered conditions."""
    x, y, r, b = box
    width = max(1, r - x)
    height = max(1, b - y)
    lines = [
        l
        for l in lines
        if l.get("text")
        and l["box"][2] > x
        and l["box"][0] < r
        and l["box"][3] > y
        and l["box"][1] < b
    ]
    markers = [
        (line, number_marker(line))
        for line in lines
        if number_marker(line)
        and re.sub(r"^\d+[.、·\s]*", "", tidy(line["text"])) != unit.get("chapterTitle")
    ]
    if subject == "chinese":
        markers = [
            m
            for m in markers
            if m[0]["box"][1] >= y + height * 0.2
            or not re.fullmatch(r"\d+", tidy(m[0]["text"]))
        ]
    if any(kind == "main" for _, (_, kind) in markers):
        markers = [m for m in markers if m[1][1] == "main"]
    # A question number belongs at a column's left edge; arithmetic operands do not split sentences.
    clusters = []
    for line, marker in sorted(markers, key=lambda v: v[0]["box"][0]):
        left = line["box"][0]
        if not clusters or left - clusters[-1][0] > width * 0.18:
            clusters.append([left, []])
        clusters[-1][1].append((line, marker))
    candidates = []
    for ci, (left, group) in enumerate(clusters):
        group = sorted(group, key=lambda v: v[0]["box"][1])
        numbers = [v[1][0] for v in group]
        if (
            len(group) == 1
            and not re.match(r"^(?:\d+[.、．·]|\(\d+\))", tidy(group[0][0]["text"]))
            and not (numbers[0] == 1 and group[0][0]["box"][0] - x < width * 0.2)
        ):
            continue
        sequence = sum(
            0 < numbers[i] - numbers[i - 1] <= 3
            or (
                numbers[i] == 1
                and group[i][0]["box"][1] - group[i - 1][0]["box"][1] > height * 0.25
            )
            for i in range(1, len(numbers))
        )
        if len(group) > 1 and sequence < max(1, len(numbers) // 2):
            continue
        col_left = x if ci == 0 else max(x, left - 20)
        col_right = min(r, clusters[ci + 1][0] - 25) if ci + 1 < len(clusters) else r
        for i, (line, (number, kind)) in enumerate(group):
            top = max(y, line["box"][1] - 12)
            bottom = min(b, group[i + 1][0]["box"][1] - 13) if i + 1 < len(group) else b
            if i + 1 < len(group):
                separators = [
                    l["box"][1] - 10
                    for l in lines
                    if re.search(
                        r"强化练习|巩固练习|基础练习|能力提升|拓展练习", l["text"]
                    )
                    and line["box"][3] + 40 < l["box"][1] < bottom
                ]
                if separators:
                    bottom = min(separators)
            if bottom - top < 25:
                continue
            included = [
                l
                for l in lines
                if col_left <= ((l["box"][0] + l["box"][2]) / 2) <= col_right
                and top <= l["box"][1] < bottom
            ]
            text = "\n".join(l["text"] for l in included).strip()
            if len(text) < 5:
                continue
            support = None
            if i == 0 and top - y > height * 0.14:
                before = [
                    l
                    for l in lines
                    if col_left <= ((l["box"][0] + l["box"][2]) / 2) <= col_right
                    and y <= l["box"][1] < top
                ]
                if subject == "chinese" and sum(len(l["text"]) for l in before) > 60:
                    support = [col_left, y, col_right, top]
                elif len(clusters) == 1 and not re.match(
                    r"^(?:结果|的正确|的答案|接上页|续上页)",
                    tidy("".join(l["text"] for l in before)),
                ):
                    top = y
            candidates.append(
                dict(
                    number=str(number),
                    box=[col_left, top, col_right, bottom],
                    supportBox=support,
                    text=text,
                    segmented=True,
                )
            )
    if not candidates:
        candidates = [
            dict(
                number="",
                box=box,
                supportBox=None,
                text="\n".join(l["text"] for l in lines),
                segmented=False,
            )
        ]
    if subject == "chinese":
        support = next(
            (
                candidate["supportBox"]
                for candidate in candidates
                if candidate.get("supportBox")
            ),
            None,
        )
        if support:
            for candidate in candidates:
                if not candidate.get("supportBox"):
                    candidate["supportBox"] = support
    result = []
    for i, item in enumerate(candidates):
        text = item.pop("text").strip()
        opts = options_in(text)
        if not opts:
            labels = re.findall(r"(?m)^\s*([A-D])[.．、]?\s*$", text)
            if (
                2 <= len(labels) <= 4
                and labels == list("ABCD")[: len(labels)]
                and (
                    subject == "math"
                    or re.search(
                        r"选择|正确|不正确|[（(]\s*[)）]|which|choose", text, re.I
                    )
                )
            ):
                opts = [
                    dict(id=letter, text="图" + letter + "（见题图）")
                    for letter in labels
                ]
        stem = (
            re.split(r"(?:^|\n)\s*A[.．、:：)）]", text, maxsplit=1)[0].strip()
            if opts
            else text
        )
        if item["number"]:
            stem = (
                re.sub(
                    r"^\(?" + re.escape(item["number"]) + r"\)?[.、．]?\s*", "", stem
                ).strip()
                or text
            )
        identity = (
            unit["id"]
            + ":"
            + hashlib.sha256(json.dumps(item["box"]).encode()).hexdigest()[:12]
        )
        result.append(
            dict(
                id=identity,
                unitId=unit["id"],
                chapterId=unit["chapterId"],
                chapterTitle=unit["chapterTitle"],
                number=item["number"],
                title=("第" + item["number"] + "题")
                if item["number"]
                else ("阅读与思考" if subject == "chinese" else "本节综合练习"),
                stem=stem[:5000],
                options=opts,
                type="choice"
                if opts
                else "reading"
                if subject == "chinese"
                else "calculation"
                if re.search(r"[×÷=]", stem)
                else "written",
                sourceBox=item["box"],
                supportBox=item["supportBox"],
                segmented=item["segmented"],
                answerStatus="needs-verification",
                sourcePage=unit["sourcePage"],
                sourceName=unit["sourceName"],
            )
        )
    return result


def clean_number(value):
    value = (
        unicodedata.normalize("NFKC", str(value))
        .replace("−", "-")
        .replace("÷", "/")
        .strip()
    )
    if not re.fullmatch(r"[+-]?(?:\d+(?:\.\d+)?|\d+/\d+)", value):
        return None
    try:
        return Fraction(value)
    except (ValueError, ZeroDivisionError):
        return None


def compare_answer(answer, expected, kind="written"):
    if not isinstance(expected, str) or not expected.strip():
        return None
    if kind == "choice":
        # A selected option may include the child's separately labelled reasoning.
        value = str(answer).split("\n想法：", 1)[0]
        return tidy(value).upper() == tidy(expected).upper()
    left, right = clean_number(answer), clean_number(expected)
    if left is not None and right is not None:
        return left == right
    return tidy(answer).casefold() == tidy(expected).casefold()


def safe_hints(value, stem, options):
    hints = []
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            continue
        text = item["text"].strip()[:240]
        if not text:
            continue
        target = item.get("target", "stem")
        quote = str(item.get("quote", ""))[:100]
        option = str(item.get("option", ""))
        if target == "option" and option not in [o["id"] for o in options]:
            target = "stem"
            option = ""
        if target not in ["stem", "option", "figure"]:
            target = "stem"
        if quote and quote not in stem:
            quote = ""
        point = item.get("point")
        if (
            not isinstance(point, list)
            or len(point) != 2
            or any(type(v) not in [int, float] for v in point)
        ):
            point = None
        elif point:
            point = [max(0.05, min(0.95, float(v))) for v in point]
        hints.append(
            dict(text=text, target=target, quote=quote, option=option, point=point)
        )
        if len(hints) == 4:
            break
    return hints


def decode_object(text):
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("AI没有返回完整的题目结构，请重试")
    return value


def analysis_items(value):
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("items"), list)
        or not 1 <= len(value["items"]) <= 60
    ):
        raise ValueError("没有识别出完整题目，请换一张清楚的题图或重试")
    output = []
    for i, item in enumerate(value["items"]):
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("stem"), str)
            or not item["stem"].strip()
        ):
            raise ValueError("题干不完整，请重试")
        stem = item["stem"].strip()[:5000]
        opts = []
        for j, opt in enumerate(
            item.get("options", [])[:6] if isinstance(item.get("options"), list) else []
        ):
            if isinstance(opt, str) and opt.strip():
                opts.append(dict(id=chr(65 + j), text=opt[:400]))
        work = str(item.get("work", ""))[:2000]
        verdict = item.get("verdict", "unverified")
        if verdict not in ["correct", "check", "blank", "unclear", "unverified"]:
            verdict = "unverified"
        if "看不清" in stem or item.get("readability") == "unclear":
            verdict = "unclear"
        elif not work.strip() and verdict in ["correct", "check"]:
            verdict = "blank"
        hints = safe_hints(item.get("hints", []), stem, opts)
        if not hints and verdict != "correct":
            hints = [
                dict(
                    text="先找一找：题目告诉了我们哪些条件？",
                    target="stem",
                    quote="",
                    option="",
                    point=None,
                )
            ]
        output.append(
            dict(
                number=str(item.get("number", i + 1))[:30],
                stem=stem,
                options=opts,
                work=work,
                verdict=verdict,
                feedback=str(item.get("feedback", ""))[:1200],
                hints=hints,
            )
        )
    return dict(
        items=output, note="AI初步核对，请结合原题检查；看不清的内容不会作为错误判定。"
    )


def check_result(value, question):
    if not isinstance(value, dict):
        raise ValueError("核对结果格式不正确")
    verdict = value.get("verdict")
    if verdict not in ["correct", "check", "unclear", "unverified"]:
        raise ValueError("没有获得可靠的核对状态，请重试")
    hints = safe_hints(
        value.get("hints", []), question["stem"], question.get("options", [])
    )
    if verdict == "check" and not hints:
        raise ValueError("没有得到可操作的小提示，请重试")
    feedback = value.get("feedback", "")
    if not isinstance(feedback, str) or not feedback.strip():
        raise ValueError("没有获得具体核对说明，请重试")
    return dict(
        verdict=verdict,
        feedback=feedback[:1200],
        hints=hints,
        basis="ai",
        note="AI结合原题给出的核对与引导，未冒充出版社标准答案。",
    )


def simple_calculation(stem):
    text = unicodedata.normalize("NFKC", stem).strip()
    text = re.sub(r"^(?:计算|口算|直接写得数)[:：\s]*", "", text)
    text = re.sub(r"=\s*(?:\(\s*\)|□|囗|\?|？)?\s*$", "", text).strip()
    text = text.replace("×", "*").replace("÷", "/").replace("−", "-")
    if len(text) > 70 or not re.fullmatch(r"[\d\s.+*/()\-]+", text):
        return None
    try:
        tree = ast.parse(text, mode="eval")
        if sum(1 for _ in ast.walk(tree)) > 30:
            return None

        def number(node):
            if isinstance(node, ast.Constant) and type(node.value) in [int, float]:
                return Fraction(str(node.value))
            if isinstance(node, ast.UnaryOp) and isinstance(
                node.op, (ast.UAdd, ast.USub)
            ):
                return number(node.operand) * (
                    -1 if isinstance(node.op, ast.USub) else 1
                )
            if isinstance(node, ast.BinOp) and isinstance(
                node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)
            ):
                a, b = number(node.left), number(node.right)
                return (
                    a + b
                    if isinstance(node.op, ast.Add)
                    else a - b
                    if isinstance(node.op, ast.Sub)
                    else a * b
                    if isinstance(node.op, ast.Mult)
                    else a / b
                )
            raise ValueError("Unsupported expression")

        result = number(tree.body)
        if abs(result) > 1000000:
            return None
        return str(result)
    except (SyntaxError, ValueError, ZeroDivisionError, OverflowError):
        return None


PHOTO_PROMPT = """准确读取所附图片的实际内容，返回一个JSON对象，不要Markdown代码围栏。
结构：{"items":[{"number":"1","stem":"完整题干和条件","options":["选项原文"],"work":"孩子实际写出的答案或步骤，没写留空","readability":"clear或unclear","verdict":"correct或check或blank或unclear或unverified","feedback":"具体核对依据或说明不确定处","hints":[{"target":"stem或figure或option","quote":"需要关注的原题关键短语","option":"选项字母，无则留空","point":[0.5,0.5],"text":"给孩子的第一步引导"}]}]}。
按图片真实题号分题。保持阅读材料和它的小题关联。条件看不清就标unclear，禁止猜数字、题干或学生答案。没有学生作答时标blank，不能判错。
只根据实际看清的答案检查；不确定判unverified。每题给1到3个从浅到深的小提示，贴着条件、图示或选项引导思考。首次不直接抄最终答案，不把正确选项写进提示。不是题目时说明实际内容并邀请重新拍摄，不能捏造练习。"""
