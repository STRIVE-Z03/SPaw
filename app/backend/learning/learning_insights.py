"""Family-scoped callers supply a child UID; this service never changes owners.

Append-only statistics contain taxonomy, timestamps and observed verdicts, never
answers, question prose, conversations, images or model reasoning. The normal
StudyHistory retention policy still controls access to the original questions.
"""

from collections import defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import re
import time

TZ = timezone(timedelta(hours=8))
SUBJECTS = dict(math="数学", chinese="语文", english="英语", other="未归类")
TASKS = dict(
    choice="选择题",
    fill="填空题",
    written="解答题",
    calculation="计算题",
    reading="阅读题",
    legacy="原有练习",
    other="未归类",
)
CURRICULUM_LABELS = dict(
    concept="概念理解",
    calculation="计算",
    application="应用",
    geometry="图形与空间",
    data="数据",
    measurement="测量",
    reasoning="推理",
    vocabulary="词汇",
    phonics="拼读",
    grammar="语法",
    reading="阅读理解",
    sentence="句型",
    writing="写作",
    culture="文化",
)
KINDS = dict(
    free="问爪爪",
    photo="拍照提问",
    homework="检查作业",
    book="教材答疑",
    arena="章节答疑",
    practice="专项练习答疑",
    legacy="原有提问",
)


def decoded(value, fallback=None):
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value) if value else fallback
    except (ValueError, TypeError):
        return fallback


def timestamp(value):
    try:
        result = float(value)
        if not math.isfinite(result) or result < 0:
            return None
        return result / 1000 if result > 100000000000 else result
    except (ValueError, TypeError):
        return None


def digest(value):
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()


def empty():
    return dict(
        answered=0,
        graded=0,
        correct=0,
        check=0,
        uncertain=0,
        drafts=0,
        accuracy=None,
        questionsAsked=0,
        activeDays=0,
        studyMinutes=0,
        readingPages=0,
    )


def counted(rows):
    result = empty()
    result["answered"] = len(rows)
    for row in rows:
        verdict = row.get("verdict")
        result[verdict if verdict in ("correct", "check") else "uncertain"] += 1
    result["graded"] = result["correct"] + result["check"]
    result["accuracy"] = (
        round(result["correct"] / result["graded"] * 100, 1)
        if result["graded"]
        else None
    )
    return result


class LearningInsights:
    def __init__(
        self,
        db,
        arena,
        library,
        study,
        clock=time.time,
        min_samples=5,
        catalog_review=None,
    ):
        if type(min_samples) is not int or not 3 <= min_samples <= 20:
            raise ValueError("知识点最少样本数需要在3到20之间")
        self.db, self.arena, self.library, self.study = db, arena, library, study
        self.clock, self.min_samples = clock, min_samples
        self.catalog_review = catalog_review
        with self.db() as conn:
            conn.executescript("""
            CREATE TABLE IF NOT EXISTS learning_insight_events(
                event_key TEXT PRIMARY KEY,user_id INTEGER NOT NULL,
                occurred INTEGER NOT NULL,kind TEXT NOT NULL,question_id TEXT NOT NULL DEFAULT '',
                facts TEXT NOT NULL,recorded INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS insight_owner_time ON learning_insight_events(user_id,occurred);
            """)

    @staticmethod
    def uid(value):
        if isinstance(value, bool) or not str(value).isdigit() or int(value) <= 0:
            raise ValueError("宝宝账号不正确")
        return int(value)

    def _rows(self, conn, table, query, args=()):
        if not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone():
            return []
        return [dict(row) for row in conn.execute(query, args)]

    def _state(self, conn, uid):
        rows = self._rows(
            conn, "user_state", "SELECT value FROM user_state WHERE user_id=?", (uid,)
        )
        value = decoded(rows[0]["value"], {}) if rows else {}
        return value if isinstance(value, dict) else {}

    def _book(self, identity):
        if not identity:
            return {}
        if isinstance(self.library, dict):
            value = self.library.get(identity)
        elif hasattr(self.library, "books"):
            value = self.library.books.get(identity)
        else:
            try:
                value = self.library.get(identity)
            except (KeyError, ValueError):
                value = None
        return (
            value if isinstance(value, dict) and value.get("kind") != "answers" else {}
        )

    def _taxonomy(self, qid, cache):
        if qid in cache:
            return cache[qid]
        try:
            q = self.arena.question(qid)
            course = self.arena.book(qid.split(":")[0])["meta"]
        except (ValueError, KeyError, TypeError):
            q, course = {}, {}
        from backend.learning.question_engine import practice_group

        group = practice_group(q, course.get("subject", "other")) if q else None
        catalog = self.catalog_review(qid, q) if q and self.catalog_review else None
        point = q.get("knowledgePoint")
        point_id = (
            point
            if isinstance(point, str)
            else point.get("id")
            if isinstance(point, dict)
            else ""
        )
        point_label = q.get("knowledgePointTitle") or (
            point.get("title") or point.get("name") if isinstance(point, dict) else ""
        )
        if not point_label and group:
            point_id, point_label = group["key"], group["label"]
        if catalog:
            point_id = point_label = catalog["title"]
        profile = q.get("profile")
        profile_id = (
            profile
            if isinstance(profile, str)
            else profile.get("id") or profile.get("key")
            if isinstance(profile, dict)
            else ""
        )
        profile_label = (
            profile.get("label") or profile.get("title")
            if isinstance(profile, dict)
            else profile_id
        ) or ""
        curriculum = (
            q.get("curriculumDimension")
            if q.get("curriculumDimension") in CURRICULUM_LABELS
            else ""
        )
        if not profile_id and curriculum:
            profile_id, profile_label = curriculum, CURRICULUM_LABELS[curriculum]
        task = (
            q.get("taskKind")
            if q.get("taskKind") in CURRICULUM_LABELS
            else q.get("type")
            if q.get("type") in TASKS
            else "other"
        )
        facts = dict(
            courseId=course.get("id") or qid.split(":")[0],
            chapterId=q.get("chapterId", ""),
            chapterTitle=q.get("chapterTitle", ""),
            subject=course.get("subject", "other"),
            knowledgePoint=point_id or "",
            knowledgePointLabel=point_label or "",
            profile=profile_id or "",
            profileLabel=profile_label,
            difficulty=catalog["difficulty"]
            if catalog
            else (
                q.get("difficulty")
                if q.get("difficulty") in ("basic", "medium", "advanced")
                else "unclassified"
            ),
            catalogVersion=catalog["sourceHash"] if catalog else "",
            taskKind=task,
            questionType=q.get("type") if q.get("type") in TASKS else "other",
            curriculumDimension=curriculum,
            retired=bool(q.get("retired")),
            sourceAvailable=bool(q),
        )
        facts["pointId"] = (
            digest([facts["courseId"], facts["chapterId"], facts["knowledgePoint"]])[
                :24
            ]
            if point_id
            else ""
        )
        cache[qid] = (facts, q)
        return facts, q

    def _ask_subject(self, context):
        if context.get("practiceSetId"):
            return "math"
        subject = self._book(context.get("bookId")).get("subject", "other")
        if context.get("questionId") or context.get("arenaUnitId"):
            try:
                subject = self.arena.book(
                    (context.get("questionId") or context["arenaUnitId"]).split(":")[0]
                )["meta"].get("subject", "other")
            except (ValueError, KeyError, TypeError):
                pass
        return subject

    def archive_question(self, conn, uid, session, seq, prompt, at):
        """Record one fact in the caller's message transaction; never store prose."""
        uid = self.uid(uid)
        if not isinstance(session, dict) or str(session.get("user_id")) != str(uid):
            raise PermissionError("提问统计与当前账号不一致")
        identity = session.get("id")
        if (
            not isinstance(identity, str)
            or not re.fullmatch(r"[a-f0-9]{32}", identity)
            or type(seq) is not int
            or seq < 1
        ):
            raise ValueError("提问统计编号不正确")
        occurred = timestamp(at)
        if (
            occurred is None
            or not isinstance(prompt, str)
            or not prompt.strip()
            or session.get("kind") not in KINDS
        ):
            raise ValueError("提问统计事实不正确")
        context = decoded(session.get("context"), {})
        if not isinstance(context, dict) or context.get("imported"):
            return False
        facts = dict(
            id=identity,
            messageSeq=seq,
            kind=session["kind"],
            subject=self._ask_subject(context),
            hasImage=bool(session.get("image_id")),
            textHash=digest(prompt.strip()),
            origin="study",
        )
        result = conn.execute(
            "INSERT OR IGNORE INTO learning_insight_events VALUES(?,?,?,?,?,?,?)",
            (
                "ask:study:" + str(uid) + ":" + identity + ":" + str(seq),
                uid,
                int(occurred),
                "ask",
                "",
                json.dumps(facts, ensure_ascii=False),
                int(self.clock()),
            ),
        )
        return result.rowcount == 1

    def archive_checks(self, uid):
        """Freeze available completed checks against their current source version."""
        self._sync(self.uid(uid), include_questions=False, include_legacy=False)

    def archive_existing(self, uid):
        """Backfill only surviving, timestamped source facts before normal pruning."""
        self._sync(self.uid(uid))

    def _ask_rows(self, conn, uid, state):
        sessions = self._rows(
            conn,
            "study_sessions",
            "SELECT id,kind,title,context,image_id,created,updated FROM study_sessions WHERE user_id=?",
            (uid,),
        )
        rows = []
        for session in sessions:
            context = decoded(session["context"], {})
            if not isinstance(context, dict) or context.get("imported"):
                continue  # Import time cannot establish when an old question was asked.
            messages = self._rows(
                conn,
                "study_messages",
                "SELECT seq,content,at FROM study_messages WHERE session_id=? AND role='user'",
                (session["id"],),
            )
            subject = self._ask_subject(context)
            for message in messages:
                at = timestamp(message.get("at"))
                if at is None or not isinstance(message.get("content"), str):
                    continue
                rows.append(
                    dict(
                        id=session["id"],
                        messageSeq=message["seq"],
                        kind=session["kind"],
                        title=session["title"],
                        questionText=message["content"],
                        at=int(at),
                        subject=subject,
                        hasImage=bool(session["image_id"]),
                        originalAvailable=session["updated"]
                        >= self.clock() - 30 * 86400,
                        eventKey="ask:study:"
                        + str(uid)
                        + ":"
                        + session["id"]
                        + ":"
                        + str(message["seq"]),
                        textHash=digest(message["content"].strip()),
                        origin="study",
                    )
                )
        modern = rows[:]
        for event in (
            state.get("questionEvents", [])
            if isinstance(state.get("questionEvents"), list)
            else []
        ):
            if not isinstance(event, dict) or not isinstance(event.get("text"), str):
                continue
            at = timestamp(event.get("at"))
            if at is None:
                continue
            hashed = digest(event["text"].strip())
            if any(
                m["textHash"] == hashed and abs(m["at"] - at) <= 120 for m in modern
            ):
                continue
            identity = (
                "legacy-" + digest([uid, int(at), event.get("book"), hashed])[:20]
            )
            rows.append(
                dict(
                    id=identity,
                    messageSeq=0,
                    kind="legacy",
                    title=event["text"][:100],
                    questionText=event["text"],
                    at=int(at),
                    subject=self._book(event.get("book")).get("subject", "other"),
                    hasImage=False,
                    originalAvailable=at >= self.clock() - 30 * 86400,
                    eventKey="ask:" + str(uid) + ":" + identity,
                    textHash=hashed,
                    origin="legacy",
                )
            )
        return rows

    def _sync(self, uid, include_questions=True, include_legacy=True):
        now = int(self.clock())
        from backend.learning.arena_work import ArenaWork

        with self.db() as conn:
            state = (
                self._state(conn, uid) if include_questions or include_legacy else {}
            )
            checks = self._rows(
                conn,
                "question_checks",
                "SELECT c.*,"
                + ArenaWork._legacy_hint_sql(conn)
                + " AS legacy_hint FROM question_checks c WHERE c.user_id=? AND c.status='done'",
                (uid,),
            )
            references = self._rows(
                conn, "question_reviews", "SELECT * FROM question_reviews"
            )
            audits = self._rows(
                conn,
                "question_review_audit",
                "SELECT question_id,value,created FROM question_review_audit",
            )
            jobs = {
                r["id"]: r
                for r in self._rows(
                    conn,
                    "study_jobs",
                    "SELECT j.id,j.updated,j.status,j.request_id,(j.prompt LIKE '请给我提示%') AS hint_only FROM study_jobs j JOIN study_sessions s ON s.id=j.session_id WHERE s.user_id=?",
                    (uid,),
                )
            }
            versions = {
                (r["question_id"], ArenaWork.reference_version(r)): r
                for r in references
                if r.get("source_hash")
            }
            for row in audits:
                value = decoded(row["value"], {})
                if isinstance(value, dict) and value.get("source_hash"):
                    versions[
                        (row["question_id"], ArenaWork.reference_version(value))
                    ] = value
            cache = {}
            for row in checks:
                if not isinstance(row.get("answer"), str) or not row["answer"].strip():
                    continue
                result = decoded(row.get("result"), {})
                if not isinstance(result, dict):
                    result = {}
                taxonomy, question = self._taxonomy(row["question_id"], cache)
                verdict = (
                    result.get("verdict")
                    if result.get("verdict") in ("correct", "check")
                    else "uncertain"
                )
                basis = result.get("basis", "")
                job = jobs.get(row.get("job_id"))
                legacy_hint = bool(row.get("legacy_hint"))
                hint_only = result.get("intent") == "hint" or legacy_hint
                limited = False
                if (
                    taxonomy["retired"]
                    or not taxonomy["sourceAvailable"]
                    or result.get("stale")
                ):
                    verdict, limited = "uncertain", True
                elif (
                    basis == "reviewed"
                    and (row["question_id"], result.get("referenceVersion"))
                    not in versions
                ):
                    verdict, limited = "uncertain", True
                elif basis == "generated" and (
                    not question.get("generated")
                    or question.get("qualityStatus") != "four-role-reviewed"
                ):
                    verdict, limited = "uncertain", True
                elif basis == "catalog-reviewed" and (
                    not taxonomy["catalogVersion"]
                    or taxonomy["catalogVersion"] != result.get("referenceVersion")
                ):
                    verdict, limited = "uncertain", True
                elif basis not in ("generated", "reviewed", "catalog-reviewed", "ai"):
                    verdict, limited = "uncertain", True
                if hint_only:
                    verdict = "uncertain"
                at = (
                    job["updated"]
                    if job
                    and job["status"] == "done"
                    and job["updated"] >= row["created"]
                    else timestamp(row["created"])
                )
                if at is None:
                    continue
                reference = versions.get(
                    (row["question_id"], result.get("referenceVersion"))
                )
                if (
                    basis == "reviewed"
                    and reference
                    and (
                        timestamp(reference.get("updated")) is None
                        or timestamp(reference["updated"]) > at
                    )
                ):
                    verdict, limited = "uncertain", True
                facts = {
                    **taxonomy,
                    "verdict": verdict,
                    "basis": basis,
                    "limited": limited,
                    "source": "chapter-check",
                    "checkId": row["id"],
                    "intent": "hint" if hint_only else "check",
                    "timeBasis": "job-completion"
                    if job and at == job["updated"]
                    else "check-request",
                    "referenceVersion": result.get("referenceVersion", ""),
                    "backfilled": now - at > 86400,
                }
                event_key = "check:" + str(uid) + ":" + str(row["id"])
                conn.execute(
                    "INSERT OR IGNORE INTO learning_insight_events VALUES(?,?,?,?,?,?,?)",
                    (
                        event_key,
                        uid,
                        int(at),
                        "check",
                        row["question_id"],
                        json.dumps(facts, ensure_ascii=False),
                        now,
                    ),
                )
                if hint_only:
                    archived = conn.execute(
                        "SELECT occurred,facts FROM learning_insight_events WHERE event_key=? AND user_id=?",
                        (event_key, uid),
                    ).fetchone()
                    original = decoded(archived["facts"], {}) if archived else {}
                    if archived and (
                        legacy_hint
                        or original.get("intent") != "hint"
                        or original.get("verdict") != "uncertain"
                    ):
                        correction = dict(
                            targetEventKey=event_key,
                            intent="hint",
                            verdict="uncertain",
                            reason="hint-only-request",
                            evidence="result-intent"
                            if result.get("intent") == "hint"
                            else "legacy-job-owner-request-context-prefix",
                            requestId=row["request_id"],
                            jobOwnerRequestVerified=legacy_hint,
                            jobContextVerified=legacy_hint,
                        )
                        # Preserve the original fact. This durable marker affects its
                        # original reporting period, while recorded is the correction time.
                        conn.execute(
                            "INSERT OR IGNORE INTO learning_insight_events VALUES(?,?,?,?,?,?,?)",
                            (
                                "check-correction:hint-only:"
                                + event_key
                                + (":owner-request-context-v3" if legacy_hint else ""),
                                uid,
                                archived["occurred"],
                                "check-correction",
                                row["question_id"],
                                json.dumps(correction, ensure_ascii=False),
                                now,
                            ),
                        )
            for row in (
                state.get("attempts", [])
                if include_legacy and isinstance(state.get("attempts"), list)
                else []
            ):
                if (
                    not isinstance(row, dict)
                    or not isinstance(row.get("question"), str)
                    or type(row.get("correct")) is not bool
                ):
                    continue
                at = timestamp(row.get("at"))
                if at is None:
                    continue
                book = self._book(row.get("book"))
                question_key = digest(
                    [row.get("book"), row.get("page"), row["question"]]
                )[:24]
                event_key = (
                    "legacy-check:"
                    + str(uid)
                    + ":"
                    + digest([question_key, at, row.get("answer"), row["correct"]])
                )
                facts = dict(
                    source="legacy-practice",
                    subject=book.get("subject", "other"),
                    verdict="correct" if row["correct"] else "check",
                    courseId="",
                    chapterId="",
                    chapterTitle="",
                    knowledgePoint="",
                    knowledgePointLabel="",
                    pointId="",
                    profile="",
                    profileLabel="",
                    difficulty="unclassified",
                    taskKind="legacy",
                    limited=True,
                    timeBasis="legacy-record",
                )
                conn.execute(
                    "INSERT OR IGNORE INTO learning_insight_events VALUES(?,?,?,?,?,?,?)",
                    (
                        event_key,
                        uid,
                        int(at),
                        "check",
                        "legacy:" + question_key,
                        json.dumps(facts, ensure_ascii=False),
                        now,
                    ),
                )
            asks = self._ask_rows(conn, uid, state) if include_questions else []
            for row in asks:
                facts = {
                    k: row[k]
                    for k in (
                        "id",
                        "messageSeq",
                        "kind",
                        "subject",
                        "hasImage",
                        "textHash",
                        "origin",
                    )
                }
                conn.execute(
                    "INSERT OR IGNORE INTO learning_insight_events VALUES(?,?,?,?,?,?,?)",
                    (
                        row["eventKey"],
                        uid,
                        row["at"],
                        "ask",
                        "",
                        json.dumps(facts, ensure_ascii=False),
                        now,
                    ),
                )
        return state, asks

    def _range(self, period, from_date, to_date):
        if period not in ("day", "week", "month", "term"):
            raise ValueError("请选择日、周、月或自定义学期区间")
        today = datetime.fromtimestamp(self.clock(), TZ).date()
        if from_date or to_date:
            if not from_date or not to_date:
                raise ValueError("请同时选择开始和结束日期")
            try:
                start, end = (
                    datetime.strptime(from_date, "%Y-%m-%d").date(),
                    datetime.strptime(to_date, "%Y-%m-%d").date(),
                )
            except (ValueError, TypeError):
                raise ValueError("日期格式应为YYYY-MM-DD") from None
        else:
            end = today
            start = (
                today
                if period == "day"
                else today - timedelta(days=6)
                if period == "week"
                else today.replace(day=1)
                if period == "month"
                else today.replace(month=9, day=1)
                if today.month >= 9
                else today.replace(month=2, day=1)
                if today.month >= 2
                else today.replace(year=today.year - 1, month=9, day=1)
            )
        if start > end or end > today or (end - start).days > 365:
            raise ValueError("请选择不超过今天、开始早于结束且最多366天的区间")
        length = (end - start).days + 1
        previous_start = start - timedelta(days=length)
        midnight = lambda value: datetime.combine(
            value, datetime.min.time(), TZ
        ).timestamp()
        return (
            dict(
                key=period,
                custom=bool(from_date),
                timezone="Asia/Shanghai",
                fromDate=start.isoformat(),
                toDate=end.isoformat(),
                previousFrom=previous_start.isoformat(),
                previousTo=(start - timedelta(days=1)).isoformat(),
                days=length,
            ),
            midnight(start),
            midnight(end + timedelta(days=1)),
            midnight(previous_start),
        )

    @staticmethod
    def _resolved_check_events(events):
        corrections = set()
        for row in events:
            facts = decoded(row.get("facts"), {})
            if (
                row.get("kind") == "check-correction"
                and facts.get("reason") == "hint-only-request"
                and facts.get("intent") == "hint"
            ):
                corrections.add(facts.get("targetEventKey"))
        resolved = []
        for row in events:
            if row.get("kind") != "check":
                continue
            facts = decoded(row.get("facts"), {})
            if facts.get("intent") == "hint" or row["event_key"] in corrections:
                facts = {**facts, "intent": "hint", "verdict": "uncertain"}
            resolved.append({**row, "facts": facts})
        return resolved

    @staticmethod
    def _latest(events, begin, end):
        by_question = {}
        for row in LearningInsights._resolved_check_events(events):
            if begin <= row["occurred"] < end:
                old = by_question.get(row["question_id"])
                # A hint is an observed request, not a new submitted result. It
                # must not erase a real check of the same question in this period.
                order = lambda value: (
                    decoded(value["facts"], {}).get("intent") != "hint",
                    value["occurred"],
                    decoded(value["facts"], {}).get("checkId", 0),
                    value["event_key"],
                )
                if not old or order(row) > order(old):
                    by_question[row["question_id"]] = row
        return [
            {
                **decoded(row["facts"], {}),
                "questionId": row["question_id"],
                "at": row["occurred"],
            }
            for row in by_question.values()
        ]

    def summary(self, uid, period="month", from_date=None, to_date=None, **dates):
        uid = self.uid(uid)
        interval, begin, end, previous_begin = self._range(
            period, from_date or dates.get("from"), to_date or dates.get("to")
        )
        state, original_questions = self._sync(uid)
        with self.db() as conn:
            events = [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM learning_insight_events WHERE user_id=? AND occurred>=? AND occurred<? ORDER BY occurred,event_key",
                    (uid, previous_begin, end),
                )
            ]
            drafts = self._rows(
                conn,
                "question_drafts",
                "SELECT question_id,answer,updated FROM question_drafts WHERE user_id=?",
                (uid,),
            )
            latest_checks = self._rows(
                conn,
                "question_checks",
                "SELECT question_id,answer,status,result FROM question_checks WHERE user_id=? ORDER BY id",
                (uid,),
            )
        current, previous = (
            self._latest(events, begin, end),
            self._latest(events, previous_begin, begin),
        )
        totals, old_totals = counted(current), counted(previous)
        latest = {
            r["question_id"]: r
            for r in latest_checks
            if isinstance(r.get("answer"), str) and r["answer"].strip()
        }
        pending = [
            r
            for r in drafts
            if isinstance(r["answer"], str)
            and r["answer"].strip()
            and begin <= r["updated"] < end
            and (
                not latest.get(r["question_id"])
                or latest[r["question_id"]]["answer"] != r["answer"]
                or latest[r["question_id"]]["status"] != "done"
            )
        ]
        totals["drafts"] = len(pending)
        totals["answered"] = len(
            {r["questionId"] for r in current} | {r["question_id"] for r in pending}
        )
        asks = [
            {**decoded(r["facts"], {}), "at": r["occurred"]}
            for r in events
            if r["kind"] == "ask"
        ]
        modern = [r for r in asks if r.get("origin") == "study"]
        asks = [
            r
            for r in asks
            if r.get("origin") != "legacy"
            or not any(
                m.get("textHash") == r.get("textHash") and abs(m["at"] - r["at"]) <= 120
                for m in modern
            )
        ]
        totals["questionsAsked"] = sum(begin <= r["at"] < end for r in asks)
        old_totals["questionsAsked"] = sum(
            previous_begin <= r["at"] < begin for r in asks
        )
        daily = state.get("daily", {}) if isinstance(state.get("daily"), dict) else {}

        def day_rows(first):
            result = []
            for offset in range(interval["days"]):
                date = (
                    (datetime.fromtimestamp(first, TZ) + timedelta(days=offset))
                    .date()
                    .isoformat()
                )
                start = first + offset * 86400
                row = counted(self._latest(events, start, start + 86400))
                day = daily.get(date, {}) if isinstance(daily.get(date), dict) else {}
                row.update(
                    date=date,
                    questionsAsked=sum(start <= r["at"] < start + 86400 for r in asks),
                    studyMinutes=round(
                        max(0, min(86400, timestamp(day.get("seconds")) or 0)) / 60, 1
                    ),
                    readingPages=len(
                        {
                            p
                            for p in day.get("pages", [])
                            if isinstance(p, str) and self._book(p.split(":")[0])
                        }
                    )
                    if isinstance(day.get("pages"), list)
                    else 0,
                )
                row["activeDays"] = int(
                    bool(
                        row["answered"]
                        or row["questionsAsked"]
                        or row["studyMinutes"]
                        or row["readingPages"]
                        or first == begin
                        and any(start <= d["updated"] < start + 86400 for d in pending)
                    )
                )
                result.append(row)
            return result

        by_day, previous_days = day_rows(begin), day_rows(previous_begin)
        totals.update(
            activeDays=sum(r["activeDays"] for r in by_day),
            studyMinutes=round(sum(r["studyMinutes"] for r in by_day), 1),
            readingPages=sum(r["readingPages"] for r in by_day),
        )
        old_totals.update(
            activeDays=sum(r["activeDays"] for r in previous_days),
            studyMinutes=round(sum(r["studyMinutes"] for r in previous_days), 1),
            readingPages=sum(r["readingPages"] for r in previous_days),
        )

        def grouped(field, labels=None):
            groups = defaultdict(list)
            for row in current:
                groups[row.get(field) or "unclassified"].append(row)
            return [
                dict(
                    id=key,
                    label=(labels or {}).get(
                        key, "未归类" if key == "unclassified" else key
                    ),
                    **counted(rows),
                )
                for key, rows in groups.items()
            ]

        now_points, old_points = defaultdict(list), defaultdict(list)
        for target, rows in ((now_points, current), (old_points, previous)):
            for row in rows:
                if row.get("pointId"):
                    target[row["pointId"]].append(row)
        points = []
        for key in dict.fromkeys([*now_points, *old_points]):
            rows, old_rows = now_points[key], old_points[key]
            info = (rows or old_rows)[0]
            count, before = counted(rows), counted(old_rows)
            sufficient = count["graded"] >= self.min_samples
            comparable = sufficient and before["graded"] >= self.min_samples
            delta = (
                round(count["accuracy"] - before["accuracy"], 1) if comparable else None
            )
            status = (
                "insufficient"
                if not sufficient
                else "needs-practice"
                if count["check"] >= 2 and count["accuracy"] < 70
                else "improving"
                if delta is not None and delta >= 10
                else "observed"
            )
            points.append(
                dict(
                    id=key,
                    label=info.get("knowledgePointLabel") or "知识点待归类",
                    subject=info.get("subject", "other"),
                    courseId=info.get("courseId"),
                    chapterId=info.get("chapterId"),
                    chapterTitle=info.get("chapterTitle"),
                    **count,
                    previousGraded=before["graded"],
                    previousAccuracy=before["accuracy"],
                    delta=delta,
                    status=status,
                    improved=comparable and delta >= 10,
                )
            )

        def dimension(name, rows):
            value = counted(rows)
            return dict(
                value=value["accuracy"]
                if value["graded"] >= self.min_samples
                else None,
                samples=value["graded"],
                sufficient=value["graded"] >= self.min_samples,
                basis=name + "相关已核对题目的一致率，不代表完整能力",
            )

        chapter_rows = [r for r in current if r.get("source") == "chapter-check"]
        dimensions = {
            key: dimension(
                SUBJECTS[key], [r for r in chapter_rows if r.get("subject") == key]
            )
            for key in ("math", "english", "chinese")
        }
        dimensions["reading"] = dimension(
            "阅读",
            [
                r
                for r in chapter_rows
                if r.get("taskKind") == "reading"
                or r.get("profile") == "reading"
                or r.get("curriculumDimension") == "reading"
            ],
        )
        dimensions["observation"] = dimension(
            "观察",
            [
                r
                for r in chapter_rows
                if r.get("profile") == "observation"
                or "观察物体" in str(r.get("chapterTitle", ""))
            ],
        )
        dimensions["habit"] = dict(
            value=None,
            samples=totals["activeDays"],
            sufficient=False,
            basis="仅有学习活动记录，无法据此评价学习习惯能力",
        )
        available = [
            r
            for r in original_questions
            if begin <= r["at"] < end and r["originalAvailable"]
        ]
        available.sort(
            key=lambda row: (row["at"], row["id"], row["messageSeq"]), reverse=True
        )
        questions = [
            {
                k: r[k]
                for k in (
                    "id",
                    "messageSeq",
                    "kind",
                    "title",
                    "questionText",
                    "at",
                    "subject",
                    "hasImage",
                )
            }
            for r in available[:200]
        ]
        sentences = [
            f"这段时间留下了{totals['graded']}道已核对题目的记录，其中{totals['correct']}道与当时的核对结果一致。"
            if totals["graded"]
            else "这段时间还没有足够的已核对作答记录，暂不评价知识掌握情况。",
            f"共有{totals['questionsAsked']}次提问记录；有学习活动的日期为{totals['activeDays']}天。",
        ]
        weak = [p for p in points if p["status"] == "needs-practice"]
        improving = [p for p in points if p["improved"]]
        if weak:
            sentences.append(
                "可以陪孩子再练一练："
                + "、".join(p["label"] for p in weak[:3])
                + "。这些结论仅针对已经练过的题目。"
            )
        if improving:
            sentences.append(
                "与前一个同长度区间相比，"
                + "、".join(p["label"] for p in improving[:3])
                + "的核对一致率提高；两期题目和难度可能不同。"
            )
        limitations = [
            "统计按实际核对和提问日期整理；每个区间每题取最后一次已完成的非空核对，不把重复检查当多个独立样本。",
            "草稿是目前待同步或待核对的状态，不参与历史正确率变化；看不清、未确定和过期参考结果不当作答错。",
            "核对一致率反映所做题目及当时核对结果，含AI核对记录，不等同于考试分数或完整能力评估。",
            "只请求提示的记录归为未确定，不计答错或薄弱项；有正式提交检查时以正式检查为准。旧提示仅按仍可核验的请求标记纠正，不猜测已清理的旧请求。",
            "提问原文和图片遵守默认30天保留规则；过期后仅保留不含题目正文的统计事实，不能补回已经删除的原文。",
            "阅读页数来自逐日阅读记录，当前读到第几页不能证明以往每天阅读了多少；未记录的活动无法补算。",
        ]
        limitations.append(
            "每日柱图按每天每题去重，区间总数按整个区间每题去重，跨日重复练同一题时两者不能直接相加。历史归档保留当时核对事实，参考资料后续变化不会改写为历史答错。"
        )
        if any(r.get("backfilled") for r in current + previous):
            limitations.append(
                "部分既有核对事实为后续归档，按可核实的请求时间和当前可归类题目整理，不能还原缺失的旧分类。"
            )
        return dict(
            schema="banxuepaw-parent-insights-v1",
            childId=uid,
            period={**interval, "from": interval["fromDate"], "to": interval["toDate"]},
            totals=totals,
            previousTotals=old_totals,
            byDay=by_day,
            bySubject=grouped("subject", SUBJECTS),
            byDifficulty=grouped(
                "difficulty",
                dict(
                    basic="基础",
                    medium="中等",
                    advanced="进阶",
                    unclassified="层次未归类",
                ),
            ),
            byTaskKind=grouped("taskKind", {**TASKS, **CURRICULUM_LABELS}),
            byQuestionType=grouped("questionType", TASKS),
            byProfile=grouped(
                "profile",
                {
                    r.get("profile"): r.get("profileLabel")
                    for r in current
                    if r.get("profileLabel")
                },
            ),
            knowledgePoints=points,
            needsPractice=weak,
            improving=improving,
            questions=questions,
            questionCount=totals["questionsAsked"],
            availableQuestionCount=len(available),
            hasMoreQuestions=len(available) > 200,
            dimensions=dimensions,
            reading=dict(
                pageRecords=totals["readingPages"],
                basis="逐日阅读记录",
                historicalPageTrajectoryAvailable=False,
            ),
            summary=sentences,
            limitations=limitations,
            minSamples=self.min_samples,
        )

    def adaptive_evidence(self, uid):
        """Read all archived checks using the same hint-correction rules as parent reports."""
        with self.db() as conn:
            uid = self.uid(uid)
            rows = [
                dict(row)
                for row in conn.execute(
                    """SELECT * FROM learning_insight_events WHERE user_id=?
                    AND kind IN ('check','check-correction') ORDER BY occurred DESC,event_key DESC""",
                    (uid,),
                )
            ]
            asks = conn.execute(
                "SELECT COUNT(*) FROM learning_insight_events WHERE user_id=? AND kind='ask'",
                (uid,),
            ).fetchone()[0]
        return self._resolved_check_events(rows), asks

    def question(self, uid, identity):
        uid = self.uid(uid)
        if re.fullmatch(r"legacy-[a-f0-9]{20}", str(identity)):
            with self.db() as conn:
                rows = self._ask_rows(conn, uid, self._state(conn, uid))
            row = next(
                (r for r in rows if r["id"] == identity and r["originalAvailable"]),
                None,
            )
            if not row:
                raise PermissionError(
                    "这条原文不存在、不属于当前宝宝或已超过默认保留窗口，仅保留统计事实"
                )
            return dict(
                id=identity,
                kind="legacy",
                title=row["title"],
                readOnly=True,
                legacy=True,
                hasImage=False,
                messages=[
                    dict(seq=1, role="user", content=row["questionText"], at=row["at"])
                ],
            )
        session = self.study.get(uid, identity)
        return dict(
            id=session["id"],
            kind=session["kind"],
            title=session["title"],
            readOnly=True,
            legacy=False,
            hasImage=bool(session.get("image_id")),
            imageUrl="/api/parent/questions/"
            + session["id"]
            + "/image?childId="
            + str(uid)
            if session.get("image_id")
            else None,
            messages=[
                {k: m[k] for k in ("seq", "role", "content", "at") if k in m}
                for m in session.get("messages", [])
            ],
        )

    def image(self, uid, identity):
        return self.study.image(self.uid(uid), identity)

    def community_snapshot(self, uid, days=30):
        """Small aggregate only; never reads conversation bodies or user_state."""
        uid = self.uid(uid)
        if type(days) is not int or not 1 <= days <= 90:
            raise ValueError("排行统计区间不正确")
        self._sync(uid, include_questions=False, include_legacy=False)
        end_date = datetime.fromtimestamp(self.clock(), TZ).date()
        start_date = end_date - timedelta(days=days - 1)
        start = datetime.combine(start_date, datetime.min.time(), TZ).timestamp()
        end = datetime.combine(
            end_date + timedelta(days=1), datetime.min.time(), TZ
        ).timestamp()
        with self.db() as conn:
            events = [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM learning_insight_events WHERE user_id=? AND kind IN ('check','check-correction') AND occurred>=? AND occurred<?",
                    (uid, start, end),
                )
            ]
        # A later uncertain hint must not erase the fact that this independent
        # question already had a completed check. Rechecks still count once.
        events = [
            r
            for r in self._resolved_check_events(events)
            if decoded(r["facts"], {}).get("source") == "chapter-check"
            and decoded(r["facts"], {}).get("verdict") in ("correct", "check")
        ]
        rows = self._latest(events, start, end)
        graded = [r for r in rows if r.get("verdict") in ("correct", "check")]

        def dimension(label, values):
            counts = counted(values)
            return dict(
                value=counts["accuracy"]
                if counts["graded"] >= self.min_samples
                else None,
                samples=counts["graded"],
                sufficient=counts["graded"] >= self.min_samples,
                basis=label + "相关已核对题目的一致率",
            )

        dimensions = {
            key: dimension(SUBJECTS[key], [r for r in rows if r.get("subject") == key])
            for key in ("math", "english", "chinese")
        }
        dimensions["reading"] = dimension(
            "阅读",
            [
                r
                for r in rows
                if r.get("taskKind") == "reading"
                or r.get("profile") == "reading"
                or r.get("curriculumDimension") == "reading"
            ],
        )
        dimensions["observation"] = dimension(
            "观察",
            [
                r
                for r in rows
                if r.get("profile") == "observation"
                or "观察物体" in str(r.get("chapterTitle", ""))
            ],
        )
        dimensions["habit"] = dict(
            value=None,
            samples=0,
            sufficient=False,
            basis="没有对应的习惯测评，不从刷题量推断能力",
        )
        return dict(
            period=dict(
                days=days,
                fromDate=start_date.isoformat(),
                toDate=end_date.isoformat(),
                timezone="Asia/Shanghai",
            ),
            uniqueQuestions=len(graded),
            correct=sum(r["verdict"] == "correct" for r in graded),
            activeDays=len(
                {datetime.fromtimestamp(r["at"], TZ).date().isoformat() for r in graded}
            ),
            dimensions=dimensions,
        )
