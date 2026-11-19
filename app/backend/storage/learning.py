"""Versioned schema and queries for personal practice."""

import json
import uuid

from backend.learning.practice_questions import grade, repeat_matches


V1 = (
    """CREATE TABLE practice_sets (
        id TEXT PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id),
        request_id TEXT NOT NULL, topic_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(student_id, request_id)
    )""",
    """CREATE TABLE practice_items (
        set_id TEXT NOT NULL REFERENCES practice_sets(id),
        id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position > 0),
        stem TEXT NOT NULL, expected_answer TEXT NOT NULL,
        PRIMARY KEY(set_id, id), UNIQUE(set_id, position)
    )""",
    """CREATE TABLE practice_attempts (
        set_id TEXT NOT NULL, item_id TEXT NOT NULL, answer TEXT NOT NULL,
        correct INTEGER NOT NULL CHECK(correct IN (0, 1)), created_at INTEGER NOT NULL,
        PRIMARY KEY(set_id, item_id),
        FOREIGN KEY(set_id, item_id) REFERENCES practice_items(set_id, id)
    )""",
    """CREATE TABLE learning_source_requests (
        student_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
    )""",
    "CREATE INDEX practice_sets_student_created ON practice_sets(student_id, created_at DESC, id DESC)",
    "CREATE INDEX learning_source_requests_student ON learning_source_requests(student_id, created_at)",
)


class PracticeRepository:
    def __init__(self, db):
        self.db = db
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS learning_migrations(version INTEGER PRIMARY KEY)"
            )
            versions = {
                row[0]
                for row in conn.execute("SELECT version FROM learning_migrations")
            }
            if 1 not in versions:
                for statement in V1:
                    conn.execute(statement)
                self._import_previous_schema(conn)
                conn.execute("INSERT INTO learning_migrations VALUES (1)")
            if 2 not in versions:
                conn.execute(
                    "ALTER TABLE practice_items ADD COLUMN details TEXT NOT NULL DEFAULT '{}'"
                )
                conn.execute("INSERT INTO learning_migrations VALUES (2)")
            if 3 not in versions:
                conn.execute(
                    "ALTER TABLE practice_sets ADD COLUMN source_set_id TEXT REFERENCES practice_sets(id)"
                )
                conn.execute("INSERT INTO learning_migrations VALUES (3)")

            if 4 not in versions:
                conn.execute(
                    "ALTER TABLE practice_sets ADD COLUMN style TEXT NOT NULL DEFAULT ''"
                )
                conn.execute(
                    "ALTER TABLE practice_attempts ADD COLUMN elapsed_seconds INTEGER"
                )
                conn.execute("INSERT INTO learning_migrations VALUES (4)")

    @staticmethod
    def _import_previous_schema(conn):
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        if "personal_practice_sets" in tables:
            for row in conn.execute("SELECT * FROM personal_practice_sets"):
                conn.execute(
                    "INSERT INTO practice_sets VALUES (?,?,?,?,?)",
                    (
                        row["id"],
                        row["user_id"],
                        row["request_id"],
                        row["topic_id"],
                        row["created"],
                    ),
                )
                conn.executemany(
                    "INSERT INTO practice_items VALUES (?,?,?,?,?)",
                    (
                        (row["id"], q["id"], i, q["stem"], q["answer"])
                        for i, q in enumerate(json.loads(row["questions"]), 1)
                    ),
                )
        if "personal_practice_attempts" in tables:
            copied = conn.execute("""INSERT INTO practice_attempts
                SELECT a.set_id, a.question_id, a.answer, a.correct, a.created
                FROM personal_practice_attempts a JOIN practice_sets s
                  ON s.id=a.set_id AND s.student_id=a.user_id""").rowcount
            expected = conn.execute(
                "SELECT COUNT(*) FROM personal_practice_attempts"
            ).fetchone()[0]
            if copied != expected:
                raise ValueError("旧作答归属需要核对，迁移未提交")
        if "personal_source_requests" in tables:
            conn.execute(
                "INSERT INTO learning_source_requests SELECT user_id,created FROM personal_source_requests"
            )

        for old in (
            "personal_practice_attempts",
            "personal_practice_sets",
            "personal_source_requests",
        ):
            if old in tables:
                conn.execute(f"DROP TABLE {old}")

    @staticmethod
    def _view(conn, row):
        if not row:
            raise PermissionError("没有找到这组练习")
        items = conn.execute(
            """SELECT i.id,i.stem,i.details,i.expected_answer,a.answer,a.correct FROM practice_items i
            LEFT JOIN practice_attempts a ON a.set_id=i.set_id AND a.item_id=i.id
            WHERE i.set_id=? ORDER BY i.position""",
            (row["id"],),
        ).fetchall()
        questions, reviews = [], {}
        for item in items:
            details = json.loads(item["details"])
            public = {**details}
            if details.get("images"):
                prefix = f"/api/learning/practice/{row['id']}/{item['id']}/image"
                public["images"] = [
                    f"{prefix}/{index}" for index in range(len(details["images"]))
                ]
            questions.append({"id": item["id"], "stem": item["stem"], **public})
            if details and item["answer"] is not None:
                answer = (
                    json.loads(item["answer"])
                    if details["kind"] == "written"
                    else item["answer"]
                )
                _, steps = grade(answer, item["expected_answer"], details)
                reviews[item["id"]] = {"answer": answer, "steps": steps}
        return {
            "id": row["id"],
            "topicId": row["topic_id"],
            "sourceSetId": row["source_set_id"],
            "style": row["style"],
            "questions": questions,
            "reviews": reviews,
            "attempts": {
                item["id"]: bool(item["correct"])
                for item in items
                if item["correct"] is not None
            },
        }

    def get(self, student, set_id):
        with self.db() as conn:
            row = conn.execute(
                "SELECT * FROM practice_sets WHERE student_id=? AND id=?",
                (student, set_id),
            ).fetchone()
            return self._view(conn, row)

    @staticmethod
    def _validate_replay(row, source_set_id, style):
        if row["source_set_id"] != source_set_id or row["style"] != style:
            raise ValueError("请求编号已用于另一组练习")

    def replay(self, student, request_id, source_set_id, style):
        with self.db() as conn:
            row = conn.execute(
                "SELECT * FROM practice_sets WHERE student_id=? AND request_id=?",
                (student, request_id),
            ).fetchone()
            if row:
                self._validate_replay(row, source_set_id, style)
                return self._view(conn, row)
        return None

    def create(
        self,
        student,
        request_id,
        topic_id,
        questions,
        now,
        source_set_id=None,
        style="",
    ):
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM practice_sets WHERE student_id=? AND request_id=?",
                (student, request_id),
            ).fetchone()
            if row:
                self._validate_replay(row, source_set_id, style)
                if style:
                    return self._view(conn, row)
                if source_set_id is None and row["topic_id"] != topic_id:
                    raise ValueError("请求编号已用于其他知识点")
                view = self._view(conn, row)
                if len(view["questions"]) != len(questions) or bool(
                    view["questions"][0].get("kind")
                ) != bool(questions[0][2]):
                    raise ValueError("请求编号已用于另一种练习")
                return view
            identity = uuid.uuid4().hex
            conn.execute(
                "INSERT INTO practice_sets(id,student_id,request_id,topic_id,created_at,source_set_id,style) VALUES (?,?,?,?,?,?,?)",
                (identity, student, request_id, topic_id, now, source_set_id, style),
            )
            conn.executemany(
                "INSERT INTO practice_items(set_id,id,position,stem,expected_answer,details) VALUES (?,?,?,?,?,?)",
                (
                    (
                        identity,
                        uuid.uuid4().hex,
                        position,
                        stem,
                        answer,
                        json.dumps(details, ensure_ascii=False),
                    )
                    for position, (stem, answer, details) in enumerate(questions, 1)
                ),
            )
            row = conn.execute(
                "SELECT * FROM practice_sets WHERE id=?", (identity,)
            ).fetchone()
            return self._view(conn, row)

    @staticmethod
    def _item(conn, student, set_id, item_id):
        item = conn.execute(
            """SELECT COALESCE(json_extract(i.details,'$.topicId'),s.topic_id) AS topic_id,
                      i.stem,i.details,i.expected_answer,a.answer,a.correct FROM practice_items i
            JOIN practice_sets s ON s.id=i.set_id
            LEFT JOIN practice_attempts a ON a.set_id=i.set_id AND a.item_id=i.id
            WHERE s.student_id=? AND i.set_id=? AND i.id=?""",
            (student, set_id, item_id),
        ).fetchone()
        if not item:
            raise PermissionError("没有找到这道练习题")
        return item

    def item(self, student, set_id, item_id):
        with self.db() as conn:
            item = dict(self._item(conn, student, set_id, item_id))
        item["details"] = json.loads(item["details"])
        return item

    def submit(self, student, set_id, item_id, answer, now, elapsed=None):
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            item = self._item(conn, student, set_id, item_id)
            details = json.loads(item["details"])
            canonical, steps = grade(answer, item["expected_answer"], details)
            if item["answer"] is not None:
                if not repeat_matches(item["answer"], canonical, details):
                    raise ValueError("这道题已经提交，可以继续下一题")
                if not details:
                    steps[0]["correct"] = bool(item["correct"])
            else:
                conn.execute(
                    "INSERT INTO practice_attempts(set_id,item_id,answer,correct,created_at,elapsed_seconds) VALUES (?,?,?,?,?,?)",
                    (
                        set_id,
                        item_id,
                        canonical,
                        int(all(step["correct"] for step in steps)),
                        now,
                        elapsed,
                    ),
                )
            return item["topic_id"], steps, bool(details)

    def activity(self, student):
        with self.db() as conn:
            return conn.execute(
                """SELECT COALESCE(json_extract(i.details,'$.topicId'),s.topic_id) AS topic_id,
                          i.stem,i.details,i.id,s.id AS set_id,a.correct,a.created_at,
                          a.elapsed_seconds,a.rowid AS ordinal
                FROM practice_sets s
                JOIN practice_attempts a ON a.set_id=s.id
                JOIN practice_items i ON i.set_id=a.set_id AND i.id=a.item_id
                WHERE s.student_id=?
                ORDER BY a.created_at DESC,a.rowid DESC""",
                (student,),
            ).fetchall()

    def resume(self, student):
        with self.db() as conn:
            return conn.execute(
                """SELECT s.id,s.topic_id FROM practice_sets s
                WHERE s.student_id=? AND EXISTS (
                    SELECT 1 FROM practice_items i WHERE i.set_id=s.id AND NOT EXISTS (
                        SELECT 1 FROM practice_attempts a WHERE a.set_id=i.set_id AND a.item_id=i.id
                    )
                ) ORDER BY s.created_at DESC,s.id DESC LIMIT 1""",
                (student,),
            ).fetchone()

    def reserve_search(self, student, now):
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "DELETE FROM learning_source_requests WHERE student_id=? AND created_at<?",
                (student, now - 86400),
            )
            count = conn.execute(
                "SELECT COUNT(*) FROM learning_source_requests WHERE student_id=?",
                (student,),
            ).fetchone()[0]
            if count >= 10:
                raise ValueError("今天查找资料的次数已用完，请明天再试")
            conn.execute(
                "INSERT INTO learning_source_requests VALUES (?,?)", (student, now)
            )
