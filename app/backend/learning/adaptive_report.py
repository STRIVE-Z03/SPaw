"""Merge verified results across practice modes by original question."""

import json
from collections import defaultdict

from backend.learning.arena_practice import SUBJECTS, point_key
from backend.learning.topics import TOPICS

GRAPH_MIN = 10
POINT_WINDOW = 8
RELIABLE_BASES = {"reviewed", "generated", "catalog-reviewed"}


def build_report(attempts, checks, asks):
    records = []
    for row in attempts:
        details = json.loads(row["details"])
        topic = TOPICS.get(row["topic_id"])
        title = details.get("pointTitle") or (topic[0] if topic else "未归类")
        origin = details.get("originId")
        records.append(
            {
                "questionId": origin or f"practice:{row['topic_id']}:{row['stem']}",
                "pointId": details.get("pointId") or row["topic_id"],
                "pointTitle": title,
                "subject": details.get("subject", "math"),
                "title": row["stem"],
                "source": "小爪练习",
                "href": f"#/learn/practice/{row['set_id']}/{row['id']}",
                "correct": bool(row["correct"]),
                "at": row["created_at"],
                "elapsed": row["elapsed_seconds"],
                "order": (1, row["ordinal"]),
            }
        )
    for row in checks:
        facts = row["facts"]
        if facts.get("intent") == "hint":
            continue
        gradeable = (
            facts.get("basis") in RELIABLE_BASES
            and not facts.get("limited")
            and not facts.get("retired")
            and facts.get("verdict") in ("correct", "check")
        )
        subject = facts.get("subject", "other")
        title = facts.get("knowledgePointLabel") or facts.get("chapterTitle", "")
        legacy = facts.get("source") == "legacy-practice"
        records.append(
            {
                "questionId": row["question_id"],
                "pointId": point_key(subject, title) if title else "",
                "pointTitle": title or "未归类",
                "subject": subject,
                "title": facts.get("chapterTitle")
                or ("早期练习" if legacy else "竞技场题目"),
                "source": "早期练习" if legacy else "竞技场",
                "href": f"#/arena/question/{row['question_id']}"
                if facts.get("sourceAvailable")
                else "",
                "correct": facts["verdict"] == "correct" if gradeable else None,
                "at": row["occurred"],
                "elapsed": None,
                "order": (0, facts.get("checkId", 0)),
            }
        )
    records.sort(key=lambda record: (record["at"], record["order"]), reverse=True)
    distinct = {}
    for record in records:
        old = distinct.get(record["questionId"])
        if old is None or old["correct"] is None and record["correct"] is not None:
            distinct[record["questionId"]] = record
    latest = sorted(
        distinct.values(),
        key=lambda record: (record["at"], record["order"]),
        reverse=True,
    )
    grouped = defaultdict(list)
    subjects = {
        subject: {"id": subject, "title": title, "graded": 0, "correct": 0}
        for subject, title in SUBJECTS.items()
    }
    graded = [record for record in latest if record["correct"] is not None]
    for record in graded:
        subject = subjects.get(record["subject"])
        if subject:
            subject["graded"] += 1
            subject["correct"] += record["correct"]
        if record["pointId"]:
            grouped[record["pointId"]].append(record)
    points = []
    for key, history in grouped.items():
        recent = history[:POINT_WINDOW]
        samples = len(recent)
        correct = sum(record["correct"] for record in recent)
        if (
            samples >= 3
            and correct * 5 >= samples * 4
            and all(r["correct"] for r in recent[:3])
        ):
            status = "mastered"
        elif samples >= 3 and correct * 10 < samples * 7:
            status = "needs-practice"
        else:
            status = "observed" if samples >= 3 else "insufficient"
        points.append(
            {
                "id": key,
                "title": recent[0]["pointTitle"],
                "subject": recent[0]["subject"],
                "samples": samples,
                "correct": correct,
                "graded": len(history),
                "status": status,
            }
        )
    points.sort(
        key=lambda point: (
            ("needs-practice", "observed", "insufficient", "mastered").index(
                point["status"]
            ),
            point["correct"] / point["samples"],
            -point["samples"],
            point["title"],
        )
    )
    return {
        "points": points,
        "latest": latest,
        "records": records,
        "subjects": list(subjects.values()),
        "graded": len(graded),
        "correct": sum(record["correct"] for record in graded),
        "pending": len(latest) - len(graded),
        "questionsAsked": asks,
        "threshold": GRAPH_MIN,
    }
