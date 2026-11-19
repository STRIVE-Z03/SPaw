"""Private, resumable study conversations with a rolling 30-day retention window."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib, json, re, secrets, threading, time

DAY = 86400


class StudyHistory:
    def __init__(
        self,
        db,
        private,
        clock=time.time,
        fact_observer=None,
        prune_on_init=True,
        quota_reserve=None,
        quota_settle=None,
    ):
        if fact_observer is not None and not callable(fact_observer):
            raise ValueError("提问统计回调不可用")
        if type(prune_on_init) is not bool:
            raise ValueError("历史清理启动选项不正确")
        self.db, self.clock = db, clock
        self.fact_observer = fact_observer
        self.quota_reserve, self.quota_settle = quota_reserve, quota_settle
        self.images = Path(private) / "study-images"
        self.images.mkdir(exist_ok=True)
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="study")
        self.runs = {}
        self.last_prune = 0
        with db() as conn:
            conn.executescript("""
            CREATE TABLE IF NOT EXISTS study_sessions(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,client_id TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,context TEXT NOT NULL,image_id TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(user_id,client_id));
            CREATE INDEX IF NOT EXISTS study_owner_updated ON study_sessions(user_id,updated DESC);
            CREATE TABLE IF NOT EXISTS study_images(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,path TEXT NOT NULL,mime TEXT NOT NULL,created INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS study_messages(session_id TEXT NOT NULL,seq INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,data TEXT,at INTEGER NOT NULL,PRIMARY KEY(session_id,seq));
            CREATE TABLE IF NOT EXISTS study_jobs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,request_id TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,partial TEXT NOT NULL DEFAULT '',stage TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(session_id,request_id));
            CREATE INDEX IF NOT EXISTS study_active_jobs ON study_jobs(session_id)
                WHERE status IN ('queued','running');
            """)
        if prune_on_init:
            self.prune(force=True)

    def recover(self):
        """Only the actual serving process calls this at startup, never a read-only importer."""
        if any(not run.get("finished") for run in self.runs.values()):
            return
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if self.quota_settle:
                for row in conn.execute(
                    "SELECT id FROM study_jobs WHERE status IN ('queued','running')"
                ).fetchall():
                    self.quota_settle(conn, row["id"], False)
            conn.execute(
                "UPDATE study_jobs SET status='error',error='服务已重新连接，提问已保存，请点重试继续。' WHERE status IN ('queued','running')"
            )

    @staticmethod
    def token(value):
        if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value):
            raise ValueError("提问记录编号不正确")
        return value

    @staticmethod
    def request_key(value):
        if not isinstance(value, str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{8,100}", value
        ):
            raise ValueError("请求编号不正确，请重新打开提问")
        return value

    def prune(self, force=False):
        now = int(self.clock())
        with self.lock:
            if not force and now - self.last_prune < 3600:
                return
            self.last_prune = now
            with self.db() as conn:
                cutoff = now - 30 * DAY
                conn.execute(
                    "DELETE FROM study_messages WHERE session_id IN (SELECT id FROM study_sessions WHERE updated<?)",
                    (cutoff,),
                )
                conn.execute(
                    "DELETE FROM study_jobs WHERE session_id IN (SELECT id FROM study_sessions WHERE updated<?)",
                    (cutoff,),
                )
                conn.execute("DELETE FROM study_sessions WHERE updated<?", (cutoff,))
                unused = list(
                    conn.execute(
                        "SELECT id,path FROM study_images WHERE id NOT IN (SELECT image_id FROM study_sessions WHERE image_id IS NOT NULL)"
                    )
                )
                for row in unused:
                    path = self.images / row["path"]
                    if (
                        re.fullmatch(r"[a-f0-9]{64}\.img", row["path"])
                        and path.resolve().parent == self.images.resolve()
                    ):
                        path.unlink(missing_ok=True)
                    conn.execute("DELETE FROM study_images WHERE id=?", (row["id"],))
            self.runs = {
                k: v
                for k, v in self.runs.items()
                if not v.get("finished") or now - v["finished"] < 600
            }

    def create(self, uid, client_id, kind, context, title="", image=None):
        self.prune()
        self.request_key(client_id)
        if kind not in ["free", "photo", "homework", "book", "arena", "practice"]:
            raise ValueError("提问类型不正确")
        if not isinstance(context, dict) or len(json.dumps(context)) > 20000:
            raise ValueError("提问上下文不正确")
        with self.lock, self.db() as conn:
            row = conn.execute(
                "SELECT id FROM study_sessions WHERE user_id=? AND client_id=?",
                (uid, client_id),
            ).fetchone()
            if row:
                return self.get(uid, row["id"])
            now = int(self.clock())
            identity = secrets.token_hex(16)
            image_id = None
            if image:
                payload, mime = image
                if (
                    not isinstance(payload, bytes)
                    or not 0 < len(payload) <= 8 * 1024**2
                ):
                    raise ValueError("题图过大，请重新拍摄")
                image_id = hashlib.sha256(
                    str(uid).encode() + b":" + payload
                ).hexdigest()
                name = image_id + ".img"
                if not (self.images / name).exists():
                    temporary = self.images / (
                        name + "." + secrets.token_hex(4) + ".tmp"
                    )
                    try:
                        temporary.write_bytes(payload)
                        temporary.replace(self.images / name)
                    finally:
                        temporary.unlink(missing_ok=True)
                conn.execute(
                    "INSERT OR IGNORE INTO study_images VALUES(?,?,?,?,?)",
                    (image_id, uid, name, mime, now),
                )
            conn.execute(
                "INSERT INTO study_sessions VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    identity,
                    uid,
                    client_id,
                    kind,
                    str(title)[:120]
                    or {
                        "photo": "拍题问爪爪",
                        "homework": "检查作业",
                        "free": "问爪爪",
                        "book": "教材答疑",
                        "arena": "章节练习答疑",
                        "practice": "专项练习答疑",
                    }[kind],
                    json.dumps(context, ensure_ascii=False),
                    image_id,
                    now,
                    now,
                ),
            )
        return self.get(uid, identity)

    def _session(self, conn, uid, identity):
        self.token(identity)
        row = conn.execute(
            "SELECT * FROM study_sessions WHERE id=? AND user_id=? AND updated>=?",
            (identity, uid, int(self.clock()) - 30 * DAY),
        ).fetchone()
        if not row:
            raise PermissionError("这条提问不存在、已超过30天或不属于当前账号")
        return dict(row)

    def get(self, uid, identity):
        self.prune()
        with self.db() as conn:
            session = self._session(conn, uid, identity)
            session["context"] = json.loads(session["context"])
            session["messages"] = [
                {**dict(r), "data": json.loads(r["data"]) if r["data"] else None}
                for r in conn.execute(
                    "SELECT seq,role,content,data,at FROM study_messages WHERE session_id=? ORDER BY seq",
                    (identity,),
                )
            ]
            jobs = list(
                conn.execute(
                    "SELECT id,request_id,prompt,status,partial,stage,error,updated FROM study_jobs WHERE session_id=? ORDER BY rowid DESC LIMIT 1",
                    (identity,),
                )
            )
            session["job"] = dict(jobs[0]) if jobs else None
            session["imageUrl"] = (
                "/api/study/sessions/" + identity + "/image"
                if session["image_id"]
                else None
            )
            return session

    def list(self, uid, kind="", search="", offset=0):
        self.prune()
        offset = max(0, min(10000, int(offset)))
        where = "user_id=? AND updated>=?"
        args = [uid, int(self.clock()) - 30 * DAY]
        if kind == "pictures":
            where += " AND kind IN ('photo','homework')"
        elif kind in ["free", "photo", "homework", "book", "arena", "practice"]:
            where += " AND kind=?"
            args.append(kind)
        if search:
            where += " AND title LIKE ? ESCAPE '\\'"
            args.append(
                "%"
                + str(search)[:100]
                .replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_")
                + "%"
            )
        with self.db() as conn:
            rows = [
                dict(r)
                for r in conn.execute(
                    "SELECT id,kind,title,created,updated,image_id FROM study_sessions WHERE "
                    + where
                    + " ORDER BY updated DESC,id DESC LIMIT 51 OFFSET ?",
                    (*args, offset),
                )
            ]
        for row in rows:
            row["hasImage"] = bool(row.pop("image_id"))
        return dict(
            items=rows[:50], hasMore=len(rows) > 50, retentionDays=30, offset=offset
        )

    def image(self, uid, identity):
        with self.db() as conn:
            session = self._session(conn, uid, identity)
            row = conn.execute(
                "SELECT path,mime FROM study_images WHERE id=? AND user_id=?",
                (session["image_id"], uid),
            ).fetchone()
        if not row:
            raise ValueError("这条记录没有可用题图")
        path = self.images / row["path"]
        if path.resolve().parent != self.images.resolve() or not path.is_file():
            raise ValueError("题图暂时无法读取")
        return path.read_bytes(), row["mime"]

    def start(self, uid, identity, request_id, prompt, worker, input_data=None):
        self.request_key(request_id)
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 6000:
            raise ValueError("请输入不超过6000字的问题")
        with self.lock, self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            session = self._session(conn, uid, identity)
            if input_data is not None and session["kind"] != "practice":
                raise ValueError("草稿只用于当前专项练习")
            old = conn.execute(
                "SELECT * FROM study_jobs WHERE session_id=? AND request_id=?",
                (identity, request_id),
            ).fetchone()
            if old and old["prompt"] != prompt.strip():
                raise ValueError("请求编号已用于其他提问")
            if old and old["status"] != "error":
                return dict(old)
            active = "status IN ('queued','running')"
            if conn.execute(
                f"SELECT 1 FROM study_jobs WHERE session_id=? AND {active}", (identity,)
            ).fetchone():
                raise ValueError("这条提问还在回复，请等本次回复完成")
            if old:
                latest = conn.execute(
                    "SELECT id FROM study_jobs WHERE session_id=? ORDER BY rowid DESC LIMIT 1",
                    (identity,),
                ).fetchone()
                if latest["id"] != old["id"]:
                    raise ValueError("已有更新的提问，请从最近一条继续")
            running = conn.execute(
                "SELECT COUNT(*) FROM study_jobs j JOIN study_sessions s ON s.id=j.session_id "
                "WHERE s.user_id=? AND j.status IN ('queued','running')",
                (uid,),
            ).fetchone()[0]
            if running >= 2:
                raise ValueError("已有两条提问正在处理，请稍后继续")
            if (
                conn.execute(
                    f"SELECT COUNT(*) FROM study_jobs WHERE {active}"
                ).fetchone()[0]
                >= 12
            ):
                raise ValueError("当前提问较多，请稍后再试")
            if not old:
                job = secrets.token_hex(16)
                now = int(self.clock())
                initial = not conn.execute(
                    "SELECT 1 FROM study_messages WHERE session_id=? LIMIT 1",
                    (identity,),
                ).fetchone()
                if self.quota_reserve:
                    self.quota_reserve(conn, uid, session, job, initial)
                conn.execute(
                    "INSERT INTO study_jobs(id,session_id,request_id,prompt,status,created,updated) VALUES(?,?,?,?,?,?,?)",
                    (job, identity, request_id, prompt.strip(), "queued", now, now),
                )
                seq = conn.execute(
                    "SELECT COALESCE(MAX(seq),0)+1 FROM study_messages WHERE session_id=?",
                    (identity,),
                ).fetchone()[0]
                conn.execute(
                    "INSERT INTO study_messages VALUES(?,?,?,?,?,?)",
                    (
                        identity,
                        seq,
                        "user",
                        prompt.strip(),
                        json.dumps(input_data, ensure_ascii=False)
                        if input_data is not None
                        else None,
                        now,
                    ),
                )
                if self.fact_observer:
                    self.fact_observer(conn, uid, session, seq, prompt.strip(), now)
                conn.execute(
                    "UPDATE study_sessions SET updated=?,title=CASE WHEN (SELECT COUNT(*) FROM study_messages WHERE session_id=?)=1 THEN ? ELSE title END WHERE id=?",
                    (now, identity, prompt.strip()[:70], identity),
                )
            else:
                job = old["id"]
                prompt = old["prompt"]
                initial = (
                    conn.execute(
                        "SELECT COUNT(*) FROM study_messages WHERE session_id=?",
                        (identity,),
                    ).fetchone()[0]
                    == 1
                )
                if self.quota_reserve:
                    self.quota_reserve(conn, uid, session, job, initial)
                conn.execute(
                    "UPDATE study_jobs SET status='queued',partial='',error='',stage='',updated=? WHERE id=?",
                    (int(self.clock()), job),
                )
        run = {
            "condition": threading.Condition(),
            "version": 0,
            "job": job,
            "partial": "",
            "stage": "正在准备题目",
            "status": "queued",
            "analysis": None,
            "finished": 0,
        }
        with self.lock:
            self.runs[job] = run
        self.pool.submit(self._execute, uid, identity, job, prompt, worker, run)
        return self.job(uid, job)

    def _execute(self, uid, identity, job, prompt, worker, run):
        last_save = 0

        def emit(kind, values):
            nonlocal last_save
            with run["condition"]:
                if kind == "delta":
                    run["partial"] = (run["partial"] + values.get("text", ""))[-60000:]
                elif kind == "reset":
                    run["partial"] = ""
                    run["analysis"] = None
                elif kind == "status":
                    run["stage"] = str(values.get("text", ""))[:200]
                elif kind == "analysis":
                    run["analysis"] = values
                run["version"] += 1
                run["condition"].notify_all()
            if self.clock() - last_save > 1:
                last_save = self.clock()
                with self.db() as conn:
                    conn.execute(
                        "UPDATE study_jobs SET partial=?,stage=?,updated=? WHERE id=?",
                        (run["partial"], run["stage"], int(self.clock()), job),
                    )

        try:
            with self.db() as conn:
                conn.execute(
                    "UPDATE study_jobs SET status='running' WHERE id=?", (job,)
                )
            run["status"] = "running"
            session = self.get(uid, identity)
            result = worker(session, prompt, emit)
            content = result.get("reply", "")
            if not isinstance(content, str) or not content.strip():
                raise ValueError("没有收到完整讲解，题目已保留，请重试")
            with self.db() as conn:
                conn.execute("BEGIN IMMEDIATE")
                seq = conn.execute(
                    "SELECT COALESCE(MAX(seq),0)+1 FROM study_messages WHERE session_id=?",
                    (identity,),
                ).fetchone()[0]
                conn.execute(
                    "INSERT INTO study_messages VALUES(?,?,?,?,?,?)",
                    (
                        identity,
                        seq,
                        "assistant",
                        content,
                        json.dumps(result.get("analysis"), ensure_ascii=False)
                        if result.get("analysis")
                        else None,
                        int(self.clock()),
                    ),
                )
                conn.execute(
                    "UPDATE study_jobs SET status='done',partial=?,stage='讲解已保存',error='',updated=? WHERE id=?",
                    (content, int(self.clock()), job),
                )
                if self.quota_settle:
                    self.quota_settle(conn, job, True)
                conn.execute(
                    "UPDATE study_sessions SET updated=? WHERE id=?",
                    (int(self.clock()), identity),
                )
                items = (result.get("analysis") or {}).get("items", [])
                if items and session["kind"] in ["photo", "homework"]:
                    title = " ".join(str(items[0].get("stem", "")).split())[:70]
                    if title:
                        conn.execute(
                            "UPDATE study_sessions SET title=? WHERE id=?",
                            (title, identity),
                        )
            run.update(
                status="done",
                partial=content,
                analysis=result.get("analysis"),
                stage="讲解已保存",
            )
        except Exception as error:
            message = (
                str(error)[:250]
                if isinstance(error, ValueError)
                else "处理暂时中断，题目与提问已保留，请重试"
            )
            with self.db() as conn:
                conn.execute(
                    "UPDATE study_jobs SET status='error',error=?,updated=? WHERE id=?",
                    (message, int(self.clock()), job),
                )
                if self.quota_settle:
                    self.quota_settle(conn, job, False)
            run.update(status="error", error=message)
        finally:
            with run["condition"]:
                run["finished"] = int(self.clock())
                run["version"] += 1
                run["condition"].notify_all()

    def job(self, uid, identity):
        self.token(identity)
        with self.db() as conn:
            row = conn.execute(
                "SELECT * FROM study_jobs WHERE id=?", (identity,)
            ).fetchone()
            if not row:
                raise PermissionError("提问任务不存在")
            self._session(conn, uid, row["session_id"])
            result = dict(row)
        with self.lock:
            run = self.runs.get(identity)
        if run:
            with run["condition"]:
                result.update(
                    {
                        k: v
                        for k, v in run.items()
                        if k
                        in [
                            "status",
                            "partial",
                            "stage",
                            "error",
                            "analysis",
                            "version",
                        ]
                    }
                )
        return result

    def import_legacy(self, uid, key, messages, context=None, image=None):
        if (
            not isinstance(key, str)
            or len(key) > 200
            or not isinstance(messages, list)
            or len(messages) > 200
        ):
            raise ValueError("原有对话格式不正确")
        client_id = "legacy_" + hashlib.sha256(key.encode()).hexdigest()
        session = self.create(
            uid,
            client_id,
            (context or {}).get("kind", "free"),
            context or {},
            "原有对话",
            image,
        )
        with self.lock, self.db() as conn:
            if conn.execute(
                "SELECT 1 FROM study_messages WHERE session_id=? LIMIT 1",
                (session["id"],),
            ).fetchone():
                return session["id"]
            for i, message in enumerate(messages, 1):
                if (
                    not isinstance(message, dict)
                    or message.get("role") not in ["user", "assistant"]
                    or not isinstance(message.get("content"), str)
                ):
                    continue
                content = message["content"][:12000]
                conn.execute(
                    "INSERT INTO study_messages VALUES(?,?,?,?,?,?)",
                    (
                        session["id"],
                        i,
                        message["role"],
                        content,
                        None,
                        int(self.clock()),
                    ),
                )
            title = next(
                (
                    m["content"][:70]
                    for m in messages
                    if isinstance(m, dict)
                    and m.get("role") == "user"
                    and isinstance(m.get("content"), str)
                ),
                "原有对话",
            )
            conn.execute(
                "UPDATE study_sessions SET title=? WHERE id=?", (title, session["id"])
            )
        return session["id"]
