"""Question formats and deterministic grading for personal practice."""

import json
from fractions import Fraction

from backend.learning.question_engine import clean_number


def choice(stem, answer, topic, hint, rng):
    value = Fraction(answer)
    step = Fraction(1, 10) if topic == "decimal" else 1
    options = [value + offset * step for offset in (0, 1, -1, 2)]
    rng.shuffle(options)
    return (
        stem,
        answer,
        {
            "kind": "choice",
            "options": [
                f"{float(option):.1f}" if topic == "decimal" else str(option)
                for option in options
            ],
            "hint": hint,
        },
    )


def written(topic, a, b):
    if topic == "decimal":
        stem = f"红彩带长 {a / 10:.1f} 米，蓝彩带长 {b / 10:.1f} 米。把两条接在一起，共有多长？"
        steps = ("两条彩带合起来有几个 0.1 米？", "合起来一共多少米？")
        answers = (str(a + b), f"{(a + b) / 10:.1f}")
        hint = "先把两条彩带都看成几个 0.1 米。数完以后，再把个数换回米。"
    elif topic == "triangle":
        stem = f"桌上有 {a} 张蓝色三角形纸片和 {b} 张红色三角形纸片。纸片分开放，没有共用的边。"
        steps = ("桌上一共有几张三角形纸片？", "这些纸片一共有多少条边？")
        answers = (str(a + b), str((a + b) * 3))
        hint = "先数一共有几个三角形，再想每个三角形有几条边。"
    elif topic == "multiplication":
        stem = f"有 {a} 盒蜡笔，每盒 {b} 支。老师又拿来一盒同样的蜡笔。"
        steps = ("原来一共有多少支蜡笔？", "再加一盒后，一共有多少支？")
        answers = (str(a * b), str((a + 1) * b))
        hint = "先用每盒的支数和盒数算出原来的总数。再看看新拿来一盒，多了几支。"
    elif topic == "division":
        stem = f"老师把 {a * b} 支铅笔平均分给 {b} 个小朋友。每个小朋友随后送出 1 支。"
        steps = ("每个小朋友先分到几支？", "送出 1 支后，每人还剩几支？")
        answers = (str(a), str(a - 1))
        hint = "先把总数平均分给这些小朋友，再从每人分到的数里减去 1。"
    elif topic == "subtraction":
        stem = f"盒子里有 {a + b + 6} 张贴纸。先拿走 {a} 张，又拿走 {b} 张。"
        steps = ("第一次拿走后还剩几张？", "两次都拿走后还剩几张？")
        answers = (str(b + 6), "6")
        hint = "第一次拿走后得到剩下的张数。第二次从这个数里再减。"
    else:
        stem = f"书架上有 {a} 本故事书和 {b} 本图画书。老师又放上 3 本故事书。"
        steps = ("原来一共有几本书？", "放上这 3 本后一共有几本？")
        answers = (str(a + b), str(a + b + 3))
        hint = "先把原来的两种书合起来，再把新放上的书加进去。"
    return stem, json.dumps(answers), {"kind": "written", "steps": steps, "hint": hint}


def grade(answer, expected, details):
    kind = details.get("kind")
    if kind == "choice" and "optionIds" in details:
        if answer not in details["optionIds"]:
            raise ValueError("请选择这道题的一个选项")
        return answer, [{"correct": answer == expected, "expected": expected}]
    if kind == "choice" and answer not in details["options"]:
        raise ValueError("请选择这道题的一个选项")
    if kind == "written":
        expected_values = json.loads(expected)
        if not isinstance(answer, list) or len(answer) != len(expected_values):
            raise ValueError("请把每一步都填好")
    else:
        expected_values, answer = [expected], [answer]
    numbers = [
        clean_number(value) if isinstance(value, str) and len(value) <= 24 else None
        for value in answer
    ]
    if any(value is None for value in numbers):
        raise ValueError(
            "请填写一个数" if kind != "written" else "请在每一步填写一个数"
        )
    steps = [
        {"correct": value == clean_number(target), "expected": target}
        for value, target in zip(numbers, expected_values)
    ]
    stored = (
        json.dumps([value.strip() for value in answer], ensure_ascii=False)
        if kind == "written"
        else answer[0].strip()
    )
    return stored, steps


def repeat_matches(stored, canonical, details):
    if details.get("optionIds"):
        return stored == canonical
    if details.get("kind") == "written":
        return [clean_number(value) for value in json.loads(stored)] == [
            clean_number(value) for value in json.loads(canonical)
        ]
    return clean_number(stored) == clean_number(canonical)
