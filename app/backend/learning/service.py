"""Personal practice and lessons driven by recorded answers."""

import operator
import random
import re
import time
from collections import defaultdict

from backend.learning.adaptive_report import build_report
from backend.learning.topics import LESSONS, TOPICS
from backend.learning.practice_questions import choice, written


OPERATIONS = {
    "addition": ("+", operator.add, "把两部分合起来，再数一数。"),
    "subtraction": ("−", operator.sub, "从总数里去掉一部分，再数剩下的。"),
    "multiplication": ("×", operator.mul, "想一想，有几个相同的数相加。"),
    "division": ("÷", operator.floordiv, "把总数平均分一分。"),
    "decimal": ("+", operator.add, "先让两个数的小数点对齐，再相加。"),
    "triangle": ("+", operator.add, "沿着外边数一圈，每个三角形有 3 条边。"),
}


def questions_for(topic, rng=None, count=5):
    rng = rng or random.SystemRandom()
    symbol, calculate, _ = OPERATIONS[topic]
    if topic == "decimal":
        return [
            (f"{a / 10:.1f} + {b / 10:.1f} = ?", f"{(a + b) / 10:.1f}")
            for a, b in rng.sample(
                [(a, b) for a in range(1, 10) for b in range(1, 10)], count
            )
        ]
    if topic == "triangle":
        return [
            (f"{n} 个三角形各自画在纸上，没有共用的边。一共有多少条边？", str(n * 3))
            for n in rng.sample(range(2, 10), count)
        ]
    questions = []
    pairs = rng.sample([(a, b) for a in range(2, 13) for b in range(2, 10)], count)
    for a, b in pairs:
        if topic == "subtraction":
            a += b
        if topic == "division":
            a *= b
        questions.append((f"{a} {symbol} {b} = ?", str(calculate(a, b))))
    return questions


class PersonalLearning:
    def __init__(self, repository, insights, agent, bank, clock=time.time):
        self.repository, self.insights, self.agent, self.clock, self.bank = (
            repository,
            insights,
            agent,
            clock,
            bank,
        )

    @staticmethod
    def _topic(topic_id):
        if not isinstance(topic_id, str) or topic_id not in TOPICS:
            raise ValueError("这个知识点还没有准备好")
        return TOPICS[topic_id]

    def _report(self, uid):
        checks, asks = self.insights.adaptive_evidence(uid)
        return build_report(self.repository.activity(uid), checks, asks)

    @staticmethod
    def _records(report, offset=0, point=None):
        size = 20
        rows = report["records"]
        if point:
            rows = [row for row in rows if row["pointId"] == point]
        return {
            "items": [
                {k: v for k, v in row.items() if k != "order"}
                for row in rows[offset : offset + size]
            ],
            "nextOffset": offset + size if offset + size < len(rows) else None,
        }

    def records(self, uid, offset=0, point=None):
        return self._records(self._report(uid), offset, point)

    def dashboard(self, uid):
        report = self._report(uid)
        resume = self.repository.resume(uid)
        charts = {
            key: value
            for key, value in report.items()
            if key not in ("points", "latest", "records")
        }
        return {
            "points": report["points"],
            "topics": [{"id": key, "title": value[0]} for key, value in TOPICS.items()],
            "resume": {"id": resume["id"]} if resume else None,
            "message": "建议会随你的新作答更新。"
            if report["graded"]
            else "先做几道题，看看哪里需要多练。",
            "analysis": {**charts, **self._records(report)},
        }

    def lesson(self, topic_id, book_id=None):
        title, _, related = self._topic(topic_id)
        explanation, example, groups = LESSONS[topic_id]
        references = (
            self.agent.lesson_sources(book_id, (topic_id, *related)) if book_id else []
        )
        return {
            "id": topic_id,
            "title": title,
            "explanation": explanation,
            "example": example,
            "diagram": {"kind": topic_id, "groups": groups},
            "references": references,
            "related": [{"id": t, "title": TOPICS[t][0]} for t in related],
            "practice": True,
        }

    def public_sources(self, uid, topic_id):
        self._topic(topic_id)
        return self.agent.public_sources(
            topic_id, lambda: self.repository.reserve_search(uid, int(self.clock()))
        )

    @staticmethod
    def _with_title(result):
        topic = result["topicId"]
        title = (
            TOPICS[topic][0]
            if topic in TOPICS
            else next(
                (
                    q["pointTitle"]
                    for q in result["questions"]
                    if q.get("pointId") == topic
                ),
                "竞技场",
            )
        )
        return {**result, "title": title}

    @staticmethod
    def _request_key(request_id):
        if not isinstance(request_id, str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{8,100}", request_id
        ):
            raise ValueError("请求编号不正确")

    @staticmethod
    def _guided_items(focus, related=(), paper=False):
        rng = random.SystemRandom()
        choice_count, written_count = (6, 4) if paper else (3, 2)
        choices = [focus] * choice_count
        written_topics = [focus] * written_count
        if related:
            choices[-1] = related[0]
            written_topics[-1] = related[-1]
            if paper:
                choices[-2] = related[-1]
        choice_pool = {
            name: iter(questions_for(name, rng, choices.count(name)))
            for name in dict.fromkeys(choices)
        }
        items = []
        for name in choices:
            stem, answer = next(choice_pool[name])
            stem, answer, details = choice(stem, answer, name, OPERATIONS[name][2], rng)
            items.append((stem, answer, {**details, "topicId": name}))
        values = rng.sample(
            [(a, b) for a in range(2, 10) for b in range(2, 8)], written_count
        )
        for name, (a, b) in zip(written_topics, values):
            stem, answer, details = written(name, a, b)
            items.append((stem, answer, {**details, "topicId": name}))
        return items

    def _review_topics(self, uid, focus):
        _, _, adjacent = TOPICS[focus]
        observed = [
            point["id"]
            for point in self.dashboard(uid)["points"]
            if point["status"] == "needs-practice"
        ]
        fallback = ("addition", "multiplication") if focus == "triangle" else ()
        return [
            name
            for name in dict.fromkeys((*observed, *adjacent, *fallback))
            if name != focus
        ][:2]

    def _arena_set(
        self, uid, request_id, style, *, source=None, focus=None, grade=None
    ):
        cached = self.repository.replay(uid, request_id, source, style)
        if cached:
            return self._with_title(cached)
        topic, items = self.bank.draw(
            self._report(uid), style == "arena-paper", focus, grade
        )
        return self._with_title(
            self.repository.create(
                uid, request_id, topic, items, int(self.clock()), source, style
            )
        )

    def create_set(self, uid, topic_id, request_id, style=None, grade=None):
        self._request_key(request_id)
        if style in ("arena", "arena-paper"):
            return self._arena_set(uid, request_id, style, focus=topic_id, grade=grade)
        self._topic(topic_id)
        if style not in (None, "guided", "paper"):
            raise ValueError("练习形式不正确")
        if style:
            review = self._review_topics(uid, topic_id) if style == "paper" else ()
            items = self._guided_items(topic_id, review, paper=style == "paper")
        else:
            items = [(stem, answer, {}) for stem, answer in questions_for(topic_id)]
        return self._with_title(
            self.repository.create(uid, request_id, topic_id, items, int(self.clock()))
        )

    def next_set(self, uid, source_id, request_id):
        self._request_key(request_id)
        if not isinstance(source_id, str) or not re.fullmatch(
            r"[a-f0-9]{32}", source_id
        ):
            raise ValueError("请先完成一组练习")
        prior = self.repository.get(uid, source_id)
        if len(prior["attempts"]) != len(prior["questions"]):
            raise ValueError("做完这组后再调整下一组")
        if prior["style"] in ("arena", "arena-paper"):
            return self._arena_set(
                uid,
                request_id,
                prior["style"],
                source=source_id,
                grade=prior["questions"][0].get("grade"),
            )
        misses = defaultdict(int)
        for question in prior["questions"]:
            if not prior["attempts"][question["id"]]:
                misses[question.get("topicId", prior["topicId"])] += 1
        review = self._review_topics(uid, prior["topicId"])
        focus = (
            max(misses, key=misses.get)
            if misses
            else (review[0] if review else prior["topicId"])
        )
        review = list(
            dict.fromkeys((prior["topicId"], *self._review_topics(uid, focus)))
        )
        review = [topic for topic in review if topic != focus][:2]
        items = self._guided_items(focus, review, paper=len(prior["questions"]) >= 10)
        return self._with_title(
            self.repository.create(
                uid, request_id, focus, items, int(self.clock()), source_id
            )
        )

    def get_set(self, uid, set_id):
        return self._with_title(self.repository.get(uid, set_id))

    def submit(self, uid, set_id, question_id, answer, elapsed=None):
        if elapsed is not None and (
            type(elapsed) is not int or not 0 <= elapsed <= 3600
        ):
            raise ValueError("答题用时不正确")
        topic, steps, guided = self.repository.submit(
            uid, set_id, question_id, answer, int(self.clock()), elapsed
        )
        correct = all(step["correct"] for step in steps)
        result = dict(
            correct=correct,
            feedback="答对了。"
            if correct
            else OPERATIONS.get(topic, (None, None, "回到题目，看看哪一步需要检查。"))[
                2
            ],
        )
        if guided:
            result["review"] = {"answer": answer, "steps": steps}
        return result
