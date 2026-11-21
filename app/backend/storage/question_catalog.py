"""Approved practice labels and their textbook locations."""

import json


class QuestionCatalog:
    def __init__(self, db):
        self.db = db
        with db() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS knowledge_points(
                    id TEXT PRIMARY KEY, subject TEXT NOT NULL, grade INTEGER NOT NULL,
                    name TEXT NOT NULL, scope TEXT NOT NULL,
                    CHECK(subject IN ('math', 'chinese', 'english')),
                    CHECK(grade BETWEEN 1 AND 6)
                );
                CREATE TABLE IF NOT EXISTS knowledge_point_chapters(
                    point_id TEXT NOT NULL REFERENCES knowledge_points(id),
                    course_id TEXT NOT NULL, chapter_id TEXT NOT NULL,
                    page INTEGER CHECK(page > 0),
                    PRIMARY KEY(point_id, course_id, chapter_id)
                );
                CREATE TABLE IF NOT EXISTS practice_question_catalog(
                    id TEXT PRIMARY KEY, point_id TEXT REFERENCES knowledge_points(id),
                    kind TEXT NOT NULL, revision_hash TEXT NOT NULL CHECK(length(revision_hash)=64),
                    status TEXT NOT NULL CHECK(status IN ('pending', 'published', 'withdrawn')),
                    assessment TEXT NOT NULL CHECK(json_valid(assessment)),
                    CHECK(kind IN ('choice', 'written', 'calculation', 'fill')),
                    CHECK(status <> 'published' OR point_id IS NOT NULL)
                );
                CREATE INDEX IF NOT EXISTS practice_catalog_published_point
                    ON practice_question_catalog(point_id) WHERE status = 'published';
                CREATE INDEX IF NOT EXISTS knowledge_point_chapter_scope
                    ON knowledge_point_chapters(course_id, chapter_id);
            """)

    def add_scope(self, points):
        with self.db() as conn:
            for point in points:
                values = tuple(point[key] for key in ("id", "subject", "grade", "name", "scope"))
                conn.execute("INSERT INTO knowledge_points VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING", values)
                existing = conn.execute("SELECT * FROM knowledge_points WHERE id=?", (point["id"],)).fetchone()
                if tuple(existing) != values:
                    raise ValueError(f"知识点 {point['id']} 的定义已存在且不同")
                conn.executemany(
                    """INSERT INTO knowledge_point_chapters VALUES(?,?,?,?)
                       ON CONFLICT(point_id,course_id,chapter_id) DO UPDATE SET page=excluded.page""",
                    [(point["id"], c["courseId"], c["chapterId"], c.get("page")) for c in point["chapters"]],
                )

    def point(self, identity, grade):
        with self.db() as conn:
            row = conn.execute("SELECT * FROM knowledge_points WHERE id=? AND grade=?", (identity, grade)).fetchone()
        return dict(row) if row else None

    def points(self):
        with self.db() as conn:
            points = conn.execute("SELECT id,name,subject,grade FROM knowledge_points ORDER BY grade,subject,name,id")
            return [dict(row) for row in points]

    def chapters(self, identity):
        with self.db() as conn:
            return [dict(row) for row in conn.execute(
                """SELECT course_id AS courseId,chapter_id AS chapterId,page
                   FROM knowledge_point_chapters WHERE point_id=? ORDER BY course_id,chapter_id""", (identity,)
            )]

    def chapter_points(self, course_id, chapter_id):
        with self.db() as conn:
            return [dict(row) for row in conn.execute(
                """SELECT p.* FROM knowledge_points p JOIN knowledge_point_chapters c ON c.point_id=p.id
                   WHERE c.course_id=? AND c.chapter_id=? ORDER BY p.id""", (course_id, chapter_id)
            )]

    @staticmethod
    def _assessment(row):
        return {**row, "assessment": json.loads(row["assessment"])}

    def assignments(self, status=None):
        with self.db() as conn:
            rows = conn.execute(
                "SELECT * FROM practice_question_catalog WHERE status=? ORDER BY id" if status else
                "SELECT * FROM practice_question_catalog ORDER BY id", (status,) if status else ()
            )
            return {row["id"]: self._assessment(dict(row)) for row in rows}

    def published(self, point_id, grade):
        with self.db() as conn:
            return [dict(row) for row in conn.execute(
                """SELECT q.id,q.kind,q.revision_hash,p.name,p.subject FROM practice_question_catalog q
                   JOIN knowledge_points p ON p.id=q.point_id
                   WHERE q.status='published' AND p.id=? AND p.grade=?""", (point_id, grade)
            )]

    def stage(self, entries):
        with self.db() as conn:
            conn.executemany(
                """INSERT INTO practice_question_catalog VALUES(?,?,?,?,'pending',?)
                   ON CONFLICT(id) DO UPDATE SET point_id=excluded.point_id,kind=excluded.kind,
                   revision_hash=excluded.revision_hash,status='pending',assessment=excluded.assessment
                   WHERE practice_question_catalog.revision_hash<>excluded.revision_hash""", entries
            )

    def publish(self, decisions):
        with self.db() as conn:
            for identity, point, kind, revision, course, chapter, assessment in decisions:
                updated = conn.execute(
                    """UPDATE practice_question_catalog
                       SET point_id=?,status='published',assessment=json_set(assessment,'$.review',?)
                       WHERE id=? AND kind=? AND revision_hash=? AND status IN ('pending','withdrawn')
                         AND EXISTS (SELECT 1 FROM knowledge_point_chapters
                                     WHERE point_id=? AND course_id=? AND chapter_id=?)""",
                    (point, assessment, identity, kind, revision, point, course, chapter),
                )
                if updated.rowcount != 1:
                    raise ValueError(f"题目 {identity} 的版本或知识点已变更，请重新核对")

    def save_proposals(self, entries):
        with self.db() as conn:
            conn.executemany(
                """UPDATE practice_question_catalog SET point_id=?,assessment=?
                   WHERE id=? AND revision_hash=? AND status='pending'""", entries
            )

    def withdraw(self, identity, revision):
        with self.db() as conn:
            updated = conn.execute(
                """UPDATE practice_question_catalog SET status='withdrawn'
                   WHERE id=? AND revision_hash=? AND status='published'""", (identity, revision)
            )
            if updated.rowcount != 1:
                raise ValueError("找不到对应版本的已发布题目")
