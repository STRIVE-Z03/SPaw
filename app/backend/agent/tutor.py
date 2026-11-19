"""Bounded teaching workflow: choose sources, then stream the explanation."""

import json
import logging
import re

from backend.agent.practice_coach import submitted_steps
from backend.agent.teaching_tools import TEXTBOOK_TOOL
from backend.learning.topics import LESSONS, topic_for_text

LOG = logging.getLogger(__name__)
LOOKUP = re.compile(r"教材|课本|哪一页|哪页|对应.{0,4}知识点|哪里讲")
HINTS = {
    "addition": "先把两部分分别圈出来，想想合在一起有多少。",
    "subtraction": "先找到原来有多少，再圈出拿走的那部分。",
    "multiplication": "先找每组有几个，再数一共有几组。",
    "division": "先圈出总数和份数，再想每份是不是一样多。",
    "decimal": "先找到小数点，看看要比较的是哪一位。",
    "triangle": "沿着图形的边走一圈，先数有几条边。",
}
PRACTICE_EXAMPLES = {
    "addition": "原来有 14 本书，再放上 3 本，用 14 + 3 算总数。",
    "subtraction": "盒子里有 30 张贴纸，拿走 2 张，用 30 − 2 算剩下的。",
    "multiplication": "13 盒笔，每盒 2 支。13 组 2 支，一共 13 × 2 支。",
    "division": "42 支笔平均分给 14 人。每人拿 3 支，正好分完，因为 14 × 3 = 42。",
    "decimal": "把 1.2 和 0.3 相加。12 个 0.1 加 3 个 0.1，是 15 个 0.1，也就是 1.5。",
    "triangle": "一张三角形纸片有 3 条边。纸片分开放时，先数纸片，再把每张的 3 条边加起来。",
    "大数的数位": "在 372 里，3 在百位，表示 3 个百。把 3 移到十位，它就只表示 3 个十。",
    "大数的近似数": "把 47 四舍五入到十位，个位的 7 要进一，所以约是 50。",
    "角的度量": "钟表指向 3 点时，两个指针之间有 3 个大格，每格 30 度，合起来是 90 度。",
    "多位数乘法": "把 23 × 4 拆开算。先算 20 × 4，再加上 3 × 4，得到 92。",
    "和差与倍数": "哥哥有弟弟的 3 倍，比弟弟多 8 颗糖。多出的 2 份各有 4 颗，所以弟弟有 4 颗。",
    "单价与总价": "3 支相同的笔一共 12 元。把 12 元平均分成 3 份，每支 4 元。",
    "速度与路程": "每分钟走 5 米，走 3 分钟，就是 3 个 5 米，一共走 15 米。",
    "图形的周长": "长方形长 5 厘米、宽 3 厘米。两条长边加两条短边，周长是 16 厘米。",
}


class TutorAgent:
    def __init__(self, tools, plan):
        self.tools, self.plan = tools, plan

    def lesson_sources(self, book_id, topics):
        return self.tools.textbook_search.search(book_id, topics)

    def public_sources(self, topic, reserve):
        if not self.tools.web_search.api_key:
            return {"available": False, "sources": []}
        return self.tools.call(
            "search_public_sources",
            {"topicId": topic},
            public_topic=topic,
            reserve=reserve,
        )

    def sources_for_question(self, book_id, prompt, emit, previous="", source_hints=""):
        topics = topic_for_text(prompt) or topic_for_text(source_hints or previous)
        if not book_id:
            return topics, []
        sources = []
        try:
            terms = self.tools.textbook_search.suggest_terms(book_id, prompt)
            if not (topics or terms or LOOKUP.search(prompt)):
                return topics, []
            emit("status", {"text": "正在找教材里的例子。"})
            if topics or terms:
                sources = self.tools.textbook_search.search(
                    book_id, topics[:4], terms=terms
                )
            if LOOKUP.search(prompt) and len(sources) < 2:
                messages = [
                    {
                        "role": "system",
                        "content": "用工具找教材中的常见知识点，只传知识点名称，最多四个。不传姓名或完整题目。",
                    },
                    {"role": "user", "content": prompt[:600]},
                ]
                call = self.plan(messages, TEXTBOOK_TOOL)
                if call:
                    extra = self.tools.call(
                        call["name"], json.loads(call["arguments"]), book_id=book_id
                    )
                    by_title = {source["title"]: source for source in sources}
                    for source in extra:
                        by_title.setdefault(source["title"], source)
                    sources = list(by_title.values())[:4]
        except (OSError, ValueError, KeyError, TypeError):
            LOG.info(
                "Textbook lookup unavailable; continuing with the current question"
            )
        return topics, sources

    @staticmethod
    def evidence(sources):
        return "\n".join(
            f"{source['title']}（阅读器第 {source['page']} 页）：{source['excerpt']}"
            for source in sources
        )

    def practice_reply(self, item, book_id, prompt, emit, explain=None):
        topic = item["topic_id"]
        details = item["details"]
        hint = details.get("hint") or HINTS[topic]
        point = details.get("pointTitle")
        references = []
        if book_id:
            if point:
                references = self.tools.textbook_search.search(book_id, terms=(point,))
            else:
                references = self.lesson_sources(book_id, (topic,))
        example = re.search(r"例子|例题|举例|类似", prompt)
        lookup = LOOKUP.search(prompt)
        result = explain(references) if explain and not (example or lookup) else None
        mode = "model" if result else "local"
        if result is None:
            text = hint
            worked_example = PRACTICE_EXAMPLES.get(point or topic)
            if example and worked_example:
                text = "先看个例子。" + worked_example + "\n\n回到这道题，" + hint
            elif lookup and references:
                text = "可以打开下面的教材页看同类内容。" + hint
            elif item["answer"] is not None:
                text = "可以照这个顺序验算。" + hint
                for i, step in enumerate(submitted_steps(item), 1):
                    status = (
                        "答对了"
                        if step["correct"]
                        else (f"你填了 {step['answer']}，参考答案是 {step['expected']}")
                    )
                    text += f"\n\n第 {i} 步 · {status}。"
            emit("delta", {"text": text})
            result = {"reply": text, "model": "local-reviewed-lesson"}
        result["analysis"] = {
            "references": references,
            "supportMode": mode,
            "model": result["model"],
        }
        return result

    @staticmethod
    def offline_reply(topics, *, is_exercise, emit, sources=()):
        if not topics:
            if not sources:
                return None
            lines = ["找到教材里讲这部分的地方了。先打开下面的例子，圈出题目给的条件。"]
        elif is_exercise:
            topic = topics[0]
            lines = [HINTS[topic]]
        else:
            topic = topics[0]
            lines = [LESSONS[topic][0], LESSONS[topic][1]]
            if {"multiplication", "division"}.issubset(topics):
                lines = [
                    "乘法是把几份一样多的东西合起来；除法是把总数平均分。",
                    "每盘 3 个，2 盘共有 6 个。反过来，把 6 个平均分到 2 盘，每盘就是 3 个。",
                ]
        for index, line in enumerate(lines):
            emit("delta", {"text": ("\n\n" if index else "") + line})
        return {"reply": "\n\n".join(lines), "model": "local-reviewed-lesson"}
