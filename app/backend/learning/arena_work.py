"""Per-question drafts and check events, independent of whole-profile snapshots."""

import json, time, threading, secrets, re, hashlib
from datetime import datetime, timezone, timedelta


class ArenaWork:
    def __init__(self, db, reference_source=None):
        if reference_source is not None and not callable(reference_source):
            raise TypeError("reference_source must be callable or None")
        self.db = db
        self.lock = threading.RLock()
        self.reference_source = reference_source
        with db() as conn:
            conn.executescript("""
        CREATE TABLE IF NOT EXISTS question_drafts(user_id INTEGER NOT NULL,question_id TEXT NOT NULL,answer TEXT NOT NULL,revision INTEGER NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(user_id,question_id));
        CREATE TABLE IF NOT EXISTS question_checks(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,question_id TEXT NOT NULL,request_id TEXT NOT NULL,answer TEXT NOT NULL,result TEXT,job_id TEXT,status TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(user_id,question_id,request_id));
        CREATE TABLE IF NOT EXISTS question_reviews(question_id TEXT PRIMARY KEY,answer TEXT NOT NULL,note TEXT NOT NULL,actor_id INTEGER NOT NULL,updated INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS arena_catalog_changes(id INTEGER PRIMARY KEY,course_id TEXT NOT NULL,chapter_id TEXT NOT NULL,value TEXT NOT NULL,actor_id INTEGER NOT NULL,created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS question_views(user_id INTEGER NOT NULL,question_id TEXT NOT NULL,value TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(user_id,question_id));
        CREATE TABLE IF NOT EXISTS question_resume(user_id INTEGER PRIMARY KEY,question_id TEXT NOT NULL,updated INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS question_skip_batches(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,request_id TEXT NOT NULL,source_id TEXT NOT NULL,label TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(user_id,request_id));
        CREATE TABLE IF NOT EXISTS question_skips(user_id INTEGER NOT NULL,question_id TEXT NOT NULL,batch_id TEXT NOT NULL,active INTEGER NOT NULL,PRIMARY KEY(user_id,question_id));
        """)
        with db() as conn:
            columns = {
                r["name"] for r in conn.execute("PRAGMA table_info(question_resume)")
            }
            if "visit_token" not in columns:
                conn.execute(
                    "ALTER TABLE question_resume ADD COLUMN visit_token INTEGER NOT NULL DEFAULT 0"
                )
            columns = {
                r["name"] for r in conn.execute("PRAGMA table_info(question_reviews)")
            }
            if "source_hash" not in columns:
                conn.execute(
                    "ALTER TABLE question_reviews ADD COLUMN source_hash TEXT NOT NULL DEFAULT ''"
                )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS question_review_audit(id INTEGER PRIMARY KEY,question_id TEXT NOT NULL,value TEXT NOT NULL,actor_id INTEGER NOT NULL,created INTEGER NOT NULL)"
            )

    @staticmethod
    def _legacy_hint_sql(conn, alias="c"):
        def columns(table):
            return {
                row["name"] for row in conn.execute("PRAGMA table_info(" + table + ")")
            }

        if not (
            {"id", "session_id", "request_id", "prompt"} <= columns("study_jobs")
            and {"id", "user_id", "context"} <= columns("study_sessions")
        ):
            return "0"
        owner = "s.user_id=" + alias + ".user_id"
        if {"child_id", "parent_id"} <= columns("family_links"):
            parent = (
                "EXISTS(SELECT 1 FROM family_links f WHERE f.child_id="
                + alias
                + ".user_id AND f.parent_id=s.user_id)"
            )
            if {"id", "role"} <= columns("users"):
                parent += " AND EXISTS(SELECT 1 FROM users u WHERE u.id=s.user_id AND u.role='parent')"
            owner += " OR (" + parent + ")"
        return (
            "EXISTS(SELECT 1 FROM study_jobs j JOIN study_sessions s ON s.id=j.session_id WHERE j.id="
            + alias
            + ".job_id AND j.request_id="
            + alias
            + ".request_id AND ("
            + owner
            + ") AND CASE WHEN json_valid(s.context) THEN json_extract(s.context,'$.questionId')="
            + alias
            + ".question_id ELSE 0 END AND j.prompt LIKE '请给我提示%')"
        )

    @staticmethod
    def _hint_sql(conn, alias="c"):
        """SQL flags only: no prompt body leaves SQLite; optional tables stay optional."""

        def columns(table):
            return {
                row["name"] for row in conn.execute("PRAGMA table_info(" + table + ")")
            }

        clauses = [
            "CASE WHEN json_valid("
            + alias
            + ".result) THEN json_extract("
            + alias
            + ".result,'$.intent')='hint' ELSE 0 END"
        ]
        clauses.append(ArenaWork._legacy_hint_sql(conn, alias))
        if {"event_key", "user_id", "question_id", "kind", "facts"} <= columns(
            "learning_insight_events"
        ):
            target = "'check:'||" + alias + ".user_id||':'||" + alias + ".id"
            clauses.append(
                "EXISTS(SELECT 1 FROM learning_insight_events e WHERE e.user_id="
                + alias
                + ".user_id AND e.question_id="
                + alias
                + ".question_id AND e.kind='check-correction' AND e.event_key IN ('check-correction:hint-only:'||"
                + target
                + ",'check-correction:hint-only:'||"
                + target
                + "||':owner-request-context-v3') AND CASE WHEN json_valid(e.facts) THEN json_extract(e.facts,'$.targetEventKey')="
                + target
                + " AND json_extract(e.facts,'$.requestId')="
                + alias
                + ".request_id AND json_extract(e.facts,'$.reason')='hint-only-request' AND json_extract(e.facts,'$.intent')='hint' AND (json_extract(e.facts,'$.evidence')='result-intent' OR (json_extract(e.facts,'$.evidence')='legacy-job-owner-request-context-prefix' AND json_extract(e.facts,'$.jobOwnerRequestVerified')=1 AND json_extract(e.facts,'$.jobContextVerified')=1)) ELSE 0 END)"
            )
        return "COALESCE((" + " OR ".join(clauses) + "),0)"

    @staticmethod
    def _check_result(raw, hint_only=False):
        try:
            value = json.loads(raw) if raw else {}
        except (ValueError, TypeError):
            value = {}
        if not isinstance(value, dict):
            return {}
        return (
            {**value, "intent": "hint", "verdict": "unverified"} if hint_only else value
        )

    def load(self, uid, qid):
        with self.db() as conn:
            row = conn.execute(
                "SELECT answer,revision,updated FROM question_drafts WHERE user_id=? AND question_id=?",
                (uid, qid),
            ).fetchone()
            latest = conn.execute(
                "SELECT c.*,"
                + self._hint_sql(conn)
                + " AS hint_only FROM question_checks c WHERE c.user_id=? AND c.question_id=? ORDER BY c.id DESC LIMIT 1",
                (uid, qid),
            ).fetchone()
            view = conn.execute(
                "SELECT value FROM question_views WHERE user_id=? AND question_id=?",
                (uid, qid),
            ).fetchone()
        value = dict(row) if row else dict(answer="", revision=0, updated=0)
        value["check"] = (
            {
                **{k: latest[k] for k in ("answer", "job_id", "status", "created")},
                "result": self.current_result(
                    qid, self._check_result(latest["result"], latest["hint_only"])
                )
                if latest["result"]
                else None,
            }
            if latest
            else None
        )
        value["view"] = json.loads(view["value"]) if view else None
        return value

    def save(self, uid, qid, answer, revision):
        if not isinstance(answer, str) or len(answer) > 5000:
            raise ValueError("请填写不超过5000字的作答")
        if type(revision) != int or revision < 0:
            raise ValueError("作答版本不正确")
        with self.lock, self.db() as conn:
            row = conn.execute(
                "SELECT answer,revision FROM question_drafts WHERE user_id=? AND question_id=?",
                (uid, qid),
            ).fetchone()
            current = row["revision"] if row else 0
            if current != revision:
                if row and row["answer"] == answer:
                    return dict(conflict=False, answer=answer, revision=current)
                return dict(
                    conflict=True, answer=row["answer"] if row else "", revision=current
                )
            now = int(time.time())
            conn.execute(
                "INSERT OR REPLACE INTO question_drafts VALUES(?,?,?,?,?)",
                (uid, qid, answer, current + 1, now),
            )
            if answer.strip():
                conn.execute(
                    "UPDATE question_skips SET active=0 WHERE user_id=? AND question_id=?",
                    (uid, qid),
                )
            return dict(
                conflict=False, answer=answer, revision=current + 1, updated=now
            )

    def progress(self, uid):
        with self.db() as conn:
            drafts = conn.execute(
                "SELECT question_id,answer,updated FROM question_drafts WHERE user_id=?",
                (uid,),
            ).fetchall()
            checks = conn.execute(
                "WITH candidates AS (SELECT c.*,"
                + self._hint_sql(conn)
                + " AS hint_only FROM question_checks c WHERE c.user_id=?), ranked AS (SELECT candidates.*,ROW_NUMBER() OVER(PARTITION BY question_id ORDER BY hint_only ASC,id DESC) AS priority FROM candidates) SELECT * FROM ranked WHERE priority=1",
                (uid,),
            ).fetchall()
            references = {
                r["question_id"]: dict(r)
                for r in conn.execute("SELECT * FROM question_reviews")
            }
        rows = {
            r["question_id"]: dict(
                state="working" if r["answer"].strip() else "new", updated=r["updated"]
            )
            for r in drafts
        }
        answers = {r["question_id"]: r["answer"] for r in drafts}
        source_cache = {}
        for row in checks:
            qid = row["question_id"]
            if qid in answers and row["answer"] != answers[qid]:
                continue
            result = (
                self.current_result(
                    qid,
                    self._check_result(row["result"], row["hint_only"]),
                    references,
                    source_cache,
                )
                if row["result"]
                else {}
            )
            state = (
                "correct"
                if result.get("verdict") == "correct"
                else "review"
                if result.get("verdict") == "check"
                else "working"
            )
            rows[qid] = dict(
                state=state,
                updated=max(row["created"], rows.get(qid, {}).get("updated", 0)),
            )
        with self.db() as conn:
            for row in conn.execute(
                "SELECT s.question_id,s.batch_id,b.label,b.source_id,b.created FROM question_skips s JOIN question_skip_batches b ON b.id=s.batch_id WHERE s.user_id=? AND s.active=1",
                (uid,),
            ):
                if rows.get(row["question_id"], {}).get("state", "new") == "new":
                    rows[row["question_id"]] = dict(
                        state="skipped",
                        batchId=row["batch_id"],
                        sourceId=row["source_id"],
                        label=row["label"],
                        updated=row["created"],
                    )
        return rows

    def summary(self, uid):
        """Count unique current answers; never treat uncertain work as incorrect.

        Failed/running checks and whitespace-only hint requests are excluded.
        Each question uses its latest nonempty done request, provided it still
        matches the current draft. A changed draft is pending instead of keeping
        an old correct verdict. Reviewed-reference invalidation follows the same
        current_result() rule used by the question reader.

        total/today/byDay share these fields: attempted, checked, graded,
        correct, check, unverified, drafts, accuracy (percent or None). A question
        is counted once, on its latest usable check date or pending draft date.
        byDay is a current-state snapshot, not a historical event-count ledger.
        byCourse uses the same counters, grouped by a valid leading 20-hex
        course ID. Unclassified legacy IDs remain in totals, not course groups.
        """
        # SQLite's default trim removes only ASCII spaces; match Python strip so
        # an empty full-width-space hint cannot hide a real preceding answer.
        whitespace = " \t\n\r\v\f\x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"
        with self.db() as conn:
            hint_sql = self._hint_sql(conn)
            rows = conn.execute(
                """
                WITH candidates AS (
                    SELECT c.*,"""
                + hint_sql
                + """ AS hint_only FROM question_checks c
                    WHERE c.user_id=? AND c.status='done' AND trim(c.answer,?)<>''
                ), done_ids AS (
                    SELECT COALESCE(MAX(CASE WHEN hint_only=0 THEN id END),MAX(id)) AS id FROM candidates
                    GROUP BY question_id
                ), done AS (
                    SELECT c.* FROM candidates c JOIN done_ids i ON i.id=c.id
                ), identities AS (
                    SELECT question_id FROM question_drafts WHERE user_id=?
                    UNION SELECT question_id FROM done
                )
                SELECT i.question_id,d.answer AS draft_answer,d.updated AS draft_updated,
                       d.revision AS draft_revision,c.answer AS checked_answer,
                       c.result AS checked_result,c.created AS checked_at,c.hint_only AS checked_hint,
                       r.answer AS reference_answer,r.note AS reference_note,
                       r.updated AS reference_updated,r.source_hash AS reference_source_hash
                FROM identities i
                LEFT JOIN question_drafts d ON d.question_id=i.question_id AND d.user_id=?
                LEFT JOIN done c ON c.question_id=i.question_id
                LEFT JOIN question_reviews r ON r.question_id=i.question_id
            """,
                (uid, whitespace, uid, uid),
            ).fetchall()
        references = {
            row["question_id"]: dict(
                answer=row["reference_answer"],
                note=row["reference_note"],
                updated=row["reference_updated"],
                source_hash=row["reference_source_hash"],
            )
            for row in rows
            if row["reference_answer"] is not None
        }
        tz = timezone(timedelta(hours=8))
        today = datetime.fromtimestamp(time.time(), tz).date().isoformat()

        def empty():
            return dict(
                attempted=0,
                checked=0,
                graded=0,
                correct=0,
                check=0,
                unverified=0,
                drafts=0,
                accuracy=None,
            )

        def add(bucket, state):
            bucket["attempted"] += 1
            bucket[state] += 1
            if state != "drafts":
                bucket["checked"] += 1
            if state in ["correct", "check"]:
                bucket["graded"] += 1

        total = empty()
        days = {}
        courses = {}
        last = 0
        source_cache = {}
        for row in rows:
            has_draft = row["draft_revision"] is not None
            answer = row["draft_answer"] if has_draft else row["checked_answer"]
            if not isinstance(answer, str) or not answer.strip():
                continue
            result = None
            if row["checked_answer"] == answer and row["checked_result"]:
                try:
                    decoded = self._check_result(
                        row["checked_result"], row["checked_hint"]
                    )
                except (ValueError, TypeError):
                    decoded = None
                if isinstance(decoded, dict):
                    result = self.current_result(
                        row["question_id"], decoded, references, source_cache
                    )
            verdict = result.get("verdict") if isinstance(result, dict) else None
            state = (
                verdict
                if verdict in ["correct", "check"]
                else "unverified"
                if verdict in ["unverified", "unclear"]
                else "drafts"
            )
            stamp = (
                row["checked_at"]
                if state != "drafts"
                else row["draft_updated"]
                if has_draft
                else row["checked_at"]
            )
            stamp = int(stamp) if stamp is not None else 0
            try:
                day = datetime.fromtimestamp(stamp, tz).date().isoformat()
            except (ValueError, OverflowError, OSError):
                day = "unknown"
            add(total, state)
            add(days.setdefault(day, empty()), state)
            last = max(last, stamp)
            course = row["question_id"].split(":", 1)[0]
            if re.fullmatch(r"[0-9a-fA-F]{20}", course):
                add(courses.setdefault(course.lower(), empty()), state)
        for bucket in [total, *days.values(), *courses.values()]:
            if bucket["graded"]:
                bucket["accuracy"] = round(
                    bucket["correct"] * 100 / bucket["graded"], 1
                )
        return dict(
            date=today,
            timezone="Asia/Shanghai",
            total=total,
            today=days.get(today, empty()),
            byDay={day: days[day] for day in sorted(days)},
            byCourse={course: courses[course] for course in sorted(courses)},
            lastActivityAt=last,
        )

    def save_view(self, uid, qid, value):
        if not isinstance(value, dict):
            raise ValueError("学习位置格式不正确")
        top = value.get("top", 0)
        hint = value.get("hint", {})
        if (
            not isinstance(top, (int, float))
            or isinstance(top, bool)
            or not 0 <= top <= 1000000
        ):
            raise ValueError("学习位置不正确")
        if (
            not isinstance(hint, dict)
            or type(hint.get("index", 0)) != int
            or not 0 <= hint.get("index", 0) <= 10
        ):
            raise ValueError("提示步骤不正确")
        clean = dict(
            top=round(top),
            hint=dict(
                key=str(hint.get("key", ""))[:200],
                index=hint.get("index", 0),
                collapsed=bool(hint.get("collapsed", False)),
            ),
        )
        revision = value.get("revision")
        token = value.get("visitToken")
        visit = value.get("visit", token is None)
        if revision is not None and (type(revision) != int or revision < 0):
            raise ValueError("学习位置版本不正确")
        if token is not None and (type(token) != int or token < 0):
            raise ValueError("学习访问编号不正确")
        if type(visit) != bool:
            raise ValueError("学习访问状态不正确")
        now = int(time.time())
        with self.lock, self.db() as conn:
            row = conn.execute(
                "SELECT value FROM question_views WHERE user_id=? AND question_id=?",
                (uid, qid),
            ).fetchone()
            current = json.loads(row["value"]) if row else {}
            if revision is not None and revision != current.get("revision", 0):
                return {**current, "conflict": True}
            resume = conn.execute(
                "SELECT visit_token FROM question_resume WHERE user_id=?", (uid,)
            ).fetchone()
            current_token = resume["visit_token"] if resume else 0
            if visit:
                token = current_token + 1
                conn.execute(
                    "INSERT OR REPLACE INTO question_resume VALUES(?,?,?,?)",
                    (uid, qid, now, token),
                )
            elif token == current_token:
                conn.execute(
                    "UPDATE question_resume SET updated=? WHERE user_id=? AND question_id=?",
                    (now, uid, qid),
                )
            clean.update(
                revision=current.get("revision", 0) + 1,
                updated=now,
                visitToken=token or 0,
            )
            conn.execute(
                "INSERT OR REPLACE INTO question_views VALUES(?,?,?,?)",
                (uid, qid, json.dumps(clean, ensure_ascii=False), now),
            )
        return clean

    def resume(self, uid):
        with self.db() as conn:
            row = conn.execute(
                "SELECT question_id,updated,visit_token FROM question_resume WHERE user_id=?",
                (uid,),
            ).fetchone()
        return dict(row) if row else None

    def skip(self, uid, source, request, label, candidates, excluded=()):
        if not isinstance(request, str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{8,100}", request
        ):
            raise ValueError("跳题请求编号不正确")
        if not isinstance(excluded, list) and excluded != ():
            raise ValueError("跳题范围不正确")
        if len(excluded) > 1000:
            raise ValueError("跳题范围过大")
        with self.lock, self.db() as conn:
            old = conn.execute(
                "SELECT id,source_id FROM question_skip_batches WHERE user_id=? AND request_id=?",
                (uid, request),
            ).fetchone()
            if old:
                if old["source_id"] != source:
                    raise ValueError("请重新打开跳题确认")
                batch = old["id"]
            else:
                rows = self.progress(uid)
                eligible = [
                    q
                    for q in dict.fromkeys(candidates)
                    if q != source
                    and q not in excluded
                    and rows.get(q, {}).get("state", "new") == "new"
                ]
                if not eligible:
                    raise ValueError("没有可以跳过的同类未答题，已做记录全部保留")
                batch = secrets.token_hex(16)
                conn.execute(
                    "INSERT INTO question_skip_batches VALUES(?,?,?,?,?,?)",
                    (batch, uid, request, source, label, int(time.time())),
                )
                for q in eligible:
                    conn.execute(
                        "INSERT OR REPLACE INTO question_skips VALUES(?,?,?,1)",
                        (uid, q, batch),
                    )
            ids = [
                r["question_id"]
                for r in conn.execute(
                    "SELECT question_id FROM question_skips WHERE user_id=? AND batch_id=? AND active=1",
                    (uid, batch),
                )
            ]
        return dict(
            batchId=batch, sourceId=source, questionIds=ids, count=len(ids), label=label
        )

    def undo_skip(self, uid, batch):
        with self.lock, self.db() as conn:
            row = conn.execute(
                "SELECT source_id FROM question_skip_batches WHERE id=? AND user_id=?",
                (batch, uid),
            ).fetchone()
            if not row:
                raise PermissionError("这条跳题记录不属于当前孩子")
            conn.execute(
                "UPDATE question_skips SET active=0 WHERE user_id=? AND batch_id=?",
                (uid, batch),
            )
        return dict(ok=True, questionId=row["source_id"])

    def check_started(self, uid, qid, request, answer, job):
        with self.db() as conn:
            conn.execute(
                "INSERT INTO question_checks(user_id,question_id,request_id,answer,job_id,status,created) VALUES(?,?,?,?,?,'running',?) ON CONFLICT(user_id,question_id,request_id) DO UPDATE SET job_id=excluded.job_id",
                (uid, qid, request, answer, job, int(time.time())),
            )

    def failed(self, uid, qid, request, answer):
        with self.db() as conn:
            conn.execute(
                "INSERT INTO question_checks(user_id,question_id,request_id,answer,status,created) VALUES(?,?,?,?,'error',?) ON CONFLICT(user_id,question_id,request_id) DO UPDATE SET status='error'",
                (uid, qid, request, answer, int(time.time())),
            )

    def checked(self, uid, qid, request, answer, result):
        with self.db() as conn:
            conn.execute(
                "INSERT INTO question_checks(user_id,question_id,request_id,answer,result,status,created) VALUES(?,?,?,?,?,'done',?) ON CONFLICT(user_id,question_id,request_id) DO UPDATE SET result=excluded.result,status='done'",
                (
                    uid,
                    qid,
                    request,
                    answer,
                    json.dumps(result, ensure_ascii=False),
                    int(time.time()),
                ),
            )

    def references(self):
        with self.db() as conn:
            rows = conn.execute("SELECT * FROM question_reviews").fetchall()
        return {r["question_id"]: dict(r) for r in rows}

    def reference(self, qid, source_hash=None):
        with self.db() as conn:
            row = conn.execute(
                "SELECT answer,note,actor_id,updated,source_hash FROM question_reviews WHERE question_id=?",
                (qid,),
            ).fetchone()
        if not row or source_hash is not None and row["source_hash"] != source_hash:
            return None
        result = dict(row)
        result["version"] = self.reference_version(result)
        return result

    @staticmethod
    def reference_version(value):
        return hashlib.sha256(
            json.dumps(
                {k: value.get(k) for k in ["answer", "note", "source_hash", "updated"]},
                ensure_ascii=False,
                sort_keys=True,
            ).encode()
        ).hexdigest()

    def current_result(self, qid, result, references=None, source_cache=None):
        if result.get("intent") == "hint":
            return {**result, "verdict": "unverified"}
        if result.get("basis") == "reviewed":
            reference = (
                self.reference(qid) if references is None else references.get(qid)
            )
            if not reference or self.reference_version(reference) != result.get(
                "referenceVersion"
            ):
                return {
                    **result,
                    "verdict": "unverified",
                    "previousVerdict": result.get(
                        "previousVerdict", result.get("verdict")
                    ),
                    "feedback": "本题参考已更新，请保留当前作答，重新核对这一步。",
                    "hints": [],
                    "stale": True,
                }
            if self.reference_source is not None:
                # Cache within one reader/summary snapshot only. A subsequent
                # request must see a newly imported, retired or missing source.
                if source_cache is not None and qid in source_cache:
                    source = source_cache[qid]
                else:
                    try:
                        source = self.reference_source(qid)
                    except Exception:
                        source = None
                    if source_cache is not None:
                        source_cache[qid] = source
                if (
                    not isinstance(source, str)
                    or not source
                    or source != reference.get("source_hash")
                ):
                    return {
                        **result,
                        "verdict": "unverified",
                        "previousVerdict": result.get(
                            "previousVerdict", result.get("verdict")
                        ),
                        "feedback": "原题资料已更新或暂时无法确认，请保留当前作答，重新核对这一步。",
                        "hints": [],
                        "stale": True,
                    }
        return result

    def review(self, qid, answer, note, actor, source_hash=""):
        if (
            not isinstance(answer, str)
            or not answer.strip()
            or len(answer) > 2000
            or not isinstance(note, str)
            or not note.strip()
            or len(note) > 1000
        ):
            raise ValueError("请填写参考答案与核对依据")
        with self.lock, self.db() as conn:
            value = dict(
                answer=answer.strip(),
                note=note.strip(),
                source_hash=source_hash,
                updated=int(time.time()),
            )
            conn.execute(
                "INSERT OR REPLACE INTO question_reviews VALUES(?,?,?,?,?,?)",
                (
                    qid,
                    value["answer"],
                    value["note"],
                    actor,
                    value["updated"],
                    source_hash,
                ),
            )
            conn.execute(
                "INSERT INTO question_review_audit(question_id,value,actor_id,created) VALUES(?,?,?,?)",
                (qid, json.dumps(value, ensure_ascii=False), actor, value["updated"]),
            )

    def review_audit(self, qid):
        with self.db() as conn:
            rows = conn.execute(
                "SELECT * FROM question_review_audit WHERE question_id=? ORDER BY id DESC LIMIT 30",
                (qid,),
            ).fetchall()
        return [{**dict(r), "value": json.loads(r["value"])} for r in rows]

    def mappings(self, audit=False):
        with self.db() as conn:
            rows = conn.execute(
                "SELECT * FROM arena_catalog_changes ORDER BY id DESC LIMIT 300"
                if audit
                else "SELECT * FROM arena_catalog_changes WHERE id IN (SELECT MAX(id) FROM arena_catalog_changes GROUP BY course_id,chapter_id)"
            ).fetchall()
        return [{**dict(row), "value": json.loads(row["value"])} for row in rows]

    def classify(self, course, chapter, value, actor):
        with self.db() as conn:
            conn.execute(
                "INSERT INTO arena_catalog_changes(course_id,chapter_id,value,actor_id,created) VALUES(?,?,?,?,?)",
                (
                    course,
                    chapter,
                    json.dumps(value, ensure_ascii=False),
                    actor,
                    int(time.time()),
                ),
            )
