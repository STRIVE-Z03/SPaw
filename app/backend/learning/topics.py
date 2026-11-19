"""Reviewed starter topics and worked examples available offline."""

TOPICS = {
    "addition": ("加法", ("加法", "加数", "相加"), ("subtraction",)),
    "subtraction": ("减法", ("减法", "减数", "相减"), ("addition",)),
    "multiplication": ("乘法", ("乘法", "乘数", "相乘", "几倍"), ("division",)),
    "division": ("除法", ("除法", "除数", "平均分"), ("multiplication",)),
    "decimal": (
        "小数",
        ("小数的意义", "小数的加法", "小数点", "小数"),
        ("addition", "subtraction"),
    ),
    "triangle": ("三角形", ("三角形的特性", "三角形的内角", "三角形"), ()),
}

LESSONS = {
    "addition": (
        "把两部分合起来，用加法。",
        "左边有 3 个圆，右边有 2 个。合起来是 3 + 2 = 5 个。",
        (3, 2),
    ),
    "subtraction": (
        "从总数里去掉一部分，用减法。",
        "8 个圆里划掉 3 个，还剩 8 − 3 = 5 个。",
        (5, 3),
    ),
    "multiplication": (
        "几个相同的数相加，可以用乘法。",
        "每排 3 个圆，2 排共有 3 + 3 = 6 个，也就是 3 × 2 = 6 个。",
        (3, 3),
    ),
    "division": (
        "把东西平均分成几份，可以用除法。",
        "6 个圆平均分成 2 排，每排 6 ÷ 2 = 3 个。",
        (3, 3),
    ),
    "decimal": (
        "把 1 平均分成 10 份，每一份是 0.1。",
        "涂了 3 份，就是 3 个 0.1，合起来是 0.3。",
        (3, 7),
    ),
    "triangle": (
        "三条线段首尾相连，围成三角形。",
        "沿着图的外边走一圈，能数出 3 条边、3 个角。",
        (),
    ),
}


def topic_for_text(text):
    """Find explicitly named topics in first-mention order."""
    found = []
    for topic_id, (_, terms, _) in TOPICS.items():
        positions = [text.find(term) for term in terms if term in text]
        if positions:
            found.append((min(positions), topic_id))
    return [topic_id for _, topic_id in sorted(found)]
