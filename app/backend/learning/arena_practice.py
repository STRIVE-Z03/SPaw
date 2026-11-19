"""Draw from verifiable Arena questions and retain their original identity."""

import json
import os
import random
import re
from collections import Counter
from pathlib import Path

from backend.learning.question_engine import clean_number
from backend.learning.topics import topic_for_text

LEVELS = ("basic", "medium", "advanced")
SUBJECTS = {"math": "数学", "chinese": "语文", "english": "英语"}
REVIEW_FILE = (
    Path(__file__).resolve().parents[2] / "content/arena/practice-reviews.json"
)


def point_key(subject, title):
    topics = topic_for_text(title) if subject == "math" else []
    return (
        topics[0]
        if len(topics) == 1
        and title in {"加法", "减法", "乘法", "除法", "小数", "三角形"}
        else f"{subject}:{title}"
    )


def load_reviews(path=None):
    source = Path(path or os.environ.get("BANXUEPAW_ARENA_REVIEW_FILE") or REVIEW_FILE)
    return json.loads(source.read_text(encoding="utf-8")) if source.is_file() else {}


class ArenaPracticeBank:
    def __init__(self, arena, work, review_file=None):
        self.arena = arena
        self.work = work
        self.reviews = load_reviews(review_file)
        self.rng = random.SystemRandom()

    def review(self, qid, question=None):
        reference = self.reviews.get(qid)
        if not reference:
            return None
        question = question or self.arena.question(qid)
        if not question.get("retired") and reference[
            "sourceHash"
        ] == self.arena.question_fingerprint(qid):
            return reference
        return None

    def pool(self):
        arena = self.arena
        courses = {
            entry["id"]: entry
            for entry in arena.curriculum.catalog()["books"]
            if entry.get("questionCount")
        }
        if arena._open():
            courses.update((entry["id"], entry) for entry in arena._manifest["books"])
        if arena.generated:
            generated_courses = arena.generated.counts()
            courses.update(
                (identity, book["meta"])
                for identity, book in arena._virtual_books().items()
                if identity in generated_courses
            )
        reviews = self.work.references()
        for course_id in courses:
            book = arena.book(course_id)
            meta = book["meta"]
            if meta.get("subject") not in SUBJECTS:
                continue
            questions = book["questions"]
            if arena.generated and not meta.get("curriculumCourse"):
                questions = questions + arena.generated.questions(course_id)
            for question in questions:
                if question.get("retired") or question.get("type") not in (
                    "choice",
                    "written",
                    "calculation",
                    "fill",
                ):
                    continue
                curated = self.review(question["id"], question)
                if curated and question["id"] not in reviews:
                    yield self._item(question, meta, curated)
                    continue
                generated = question.get("generated")
                if generated:
                    if question.get("qualityStatus") != "four-role-reviewed":
                        continue
                    reference = arena.question(question["id"])
                else:
                    reference = reviews.get(question["id"])
                    if (
                        not reference
                        or reference.get("source_hash")
                        != arena.question_fingerprint(question["id"])
                        or not question.get("segmented")
                    ):
                        continue
                expected = reference.get("answer")
                is_choice = question["type"] == "choice"
                if not isinstance(expected, str) or not (
                    expected in [option["id"] for option in question.get("options", [])]
                    if is_choice
                    else clean_number(expected) is not None
                ):
                    continue
                yield self._item(
                    question,
                    meta,
                    {
                        "title": question.get("knowledgePointTitle")
                        or question["chapterTitle"],
                        "difficulty": question.get("difficulty"),
                        "stem": question["stem"],
                        "steps": [] if is_choice else ["填写答案"],
                        "answer": [expected],
                        "image": bool(not generated or question.get("diagram")),
                        "hint": "先找题目给了什么，再看看它要你求什么。",
                    },
                )

    @staticmethod
    def score(review, question, answer):
        if not review:
            return None
        values = review["answer"]
        if question["type"] == "choice":
            return answer.split("\n想法：", 1)[0].strip().upper() == values[0]
        parts = re.split(r"[,，、；;\n]", answer)
        if len(parts) == 1 and review.get("singleOriginalAnswer"):
            values = values[-1:]
        actual = [clean_number(part) if len(part) <= 24 else None for part in parts]
        if len(actual) != len(values) or any(value is None for value in actual):
            return None
        return actual == [clean_number(value) for value in values]

    @staticmethod
    def _item(question, course, review):
        qid, subject = question["id"], course["subject"]
        title = review["title"]
        difficulty = review["difficulty"]
        details = {
            "originId": qid,
            "pointId": point_key(subject, title),
            "pointTitle": title,
            "subject": subject,
            "grade": course.get("grade"),
            "difficulty": difficulty if difficulty in LEVELS else "unclassified",
            "hint": review["hint"],
            "kind": "choice" if question["type"] == "choice" else "written",
        }
        if details["kind"] == "choice":
            details["options"] = review.get("options") or [
                o["text"] for o in question["options"]
            ]
            details["optionIds"] = [o["id"] for o in question["options"]]
            expected = review["answer"][0]
        else:
            details["steps"] = review["steps"]
            expected = json.dumps(review["answer"])
        if review.get("image"):
            url = f"/api/arena/questions/{qid}/image"
            details["images"] = [url]
            if question.get("supportBox"):
                details["images"].append(url + "?part=context")
            if question.get("continuation"):
                details["images"].append(url + "?part=continuation")
        return review["stem"], expected, details

    def draw(self, profile, paper, focus=None, grade=None):
        pool = list(self.pool())
        at_grade = [item for item in pool if item[2]["grade"] == grade]
        pool = at_grade or pool
        if not pool:
            raise ValueError("竞技场还没有核对好的题，先去看看教材吧。")
        assessments = {p["id"]: p for p in profile["points"]}
        origin = {
            r["questionId"]: r for r in profile["latest"] if r["correct"] is not None
        }
        eligible = {item[2]["pointId"] for item in pool}
        if focus not in eligible:
            focus = next(
                (
                    p["id"]
                    for p in profile["points"]
                    if p["id"] in eligible and p["status"] == "needs-practice"
                ),
                None,
            )
        mastered = sum(
            p["id"] in eligible and p["status"] == "mastered" for p in profile["points"]
        )
        # Advancement requires recent evidence for each point. More mastered
        # points grow subsequent sets and introduce harder questions.
        level = min(mastered, len(LEVELS) - 1)
        count = (10 if paper else 5) + level * (2 if paper else 1)
        self.rng.shuffle(pool)

        def priority(item):
            details = item[2]
            key = details["pointId"]
            point = assessments.get(key, {})
            attempt = origin.get(details["originId"])
            rank = (
                LEVELS.index(details["difficulty"])
                if details["difficulty"] in LEVELS
                else 1
            )
            target = min(1, level) if point.get("status") == "needs-practice" else level
            # Keep new material first, then missed questions before already-correct
            # material within the same group and difficulty.
            return (
                key != focus,
                point.get("status") == "mastered" and not level,
                level == 0 and rank == 2,
                0 if attempt is None else 1 if not attempt["correct"] else 2,
                (details["difficulty"] == "unclassified", abs(rank - target)),
            )

        pool.sort(key=priority)
        focus_count = (count + 1) // 2 if focus else 0
        focused = [item for item in pool if item[2]["pointId"] == focus][:focus_count]
        chosen = {item[2]["originId"] for item in focused}
        mixed = [item for item in pool if item[2]["originId"] not in chosen]
        if focus:
            mixed.sort(key=lambda item: item[2]["pointId"] == focus)
        items = focused + mixed[: count - len(focused)]
        # Include a choice and a worked problem, where the bank contains both.
        kinds = Counter(item[2]["kind"] for item in items)
        for kind in ("choice", "written"):
            if len(items) > 1 and not kinds[kind]:
                candidate = next(
                    (item for item in pool if item[2]["kind"] == kind), None
                )
                if candidate:
                    items[-1] = candidate
                    break
        return focus or "adaptive", items
