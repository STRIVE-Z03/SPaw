"""Local accounts, expiring one-use captchas, sessions and admin management."""

import base64
import hashlib
import hmac
import io
import os
import re
import secrets
import time
import unicodedata
from http.cookies import SimpleCookie
from PIL import Image, ImageDraw, ImageFont


class Accounts:
    def __init__(self, db, private):
        self.db = db
        with db() as conn:
            conn.executescript("""
            CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE COLLATE NOCASE,child_name TEXT,salt TEXT,password_hash TEXT,role TEXT,enabled INTEGER DEFAULT 1,created INTEGER);
            CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER,expires INTEGER);
            CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
            CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY,answer_hash TEXT,expires INTEGER);
            CREATE TABLE IF NOT EXISTS user_state(user_id INTEGER PRIMARY KEY,revision INTEGER DEFAULT 0,value TEXT);
            CREATE TABLE IF NOT EXISTS reset_requests(id INTEGER PRIMARY KEY,username TEXT,message TEXT,status TEXT DEFAULT 'pending',created INTEGER);
            CREATE TABLE IF NOT EXISTS login_limits(key TEXT PRIMARY KEY,attempts INTEGER DEFAULT 0,until_at INTEGER);
            """)
            conn.execute("BEGIN IMMEDIATE")
            columns = {
                column["name"] for column in conn.execute("PRAGMA table_info(users)")
            }
            if "email" not in columns:
                conn.execute("ALTER TABLE users ADD COLUMN email TEXT")
            self._init_family_links(conn)
            admin = conn.execute(
                "SELECT id FROM users WHERE role='admin' AND enabled=1"
            ).fetchone()
        if not admin:
            password = os.environ.get(
                "BOOTSTRAP_ADMIN_PASSWORD"
            ) or secrets.token_urlsafe(15)
            self.create("admin", "本机管理员", password, "admin")
            (private / "admin-bootstrap.txt").write_text(
                "管理员账号：admin\n初始密码："
                + password
                + "\n地址：http://127.0.0.1:8765/#/admin/overview\n登录后可在个人中心修改密码。\n",
                encoding="utf-8",
            )

    @staticmethod
    def _init_family_links(conn):
        legacy = (
            conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='family_links'"
            ).fetchone()
            and not conn.execute("PRAGMA foreign_key_list(family_links)").fetchone()
        )
        if legacy:
            conn.execute("ALTER TABLE family_links RENAME TO family_links_legacy")
        conn.execute("""CREATE TABLE IF NOT EXISTS family_links (
            child_id INTEGER NOT NULL REFERENCES users(id),
            parent_id INTEGER NOT NULL REFERENCES users(id),
            created INTEGER NOT NULL, PRIMARY KEY(child_id,parent_id),
            CHECK(child_id <> parent_id)
        )""")
        if legacy:
            conn.execute("""INSERT INTO family_links(child_id,parent_id,created)
                SELECT child_id,parent_id,created FROM family_links_legacy""")
            conn.execute("DROP TABLE family_links_legacy")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS family_links_by_parent ON family_links(parent_id,child_id)"
        )

    @staticmethod
    def digest(password, salt):
        return hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt), 240000
        ).hex()

    @staticmethod
    def validate_password(password):
        if not isinstance(password, str) or not 8 <= len(password) <= 128:
            raise ValueError("密码需为 8 到 128 个字符")

    @staticmethod
    def name(value):
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= 30:
            raise ValueError("请填写 1 到 30 字的小朋友名字")
        return value.strip()

    @staticmethod
    def username(value):
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_]{3,32}", value):
            raise ValueError("用户名需为 3 到 32 位字母、数字或下划线")
        return value

    def prepare_user(self, username, name, password, role):
        username = self.username(username)
        name = self.name(name)
        self.validate_password(password)
        if role not in ("child", "parent", "admin"):
            raise ValueError("账号角色不正确")
        salt = secrets.token_hex(16)
        return username, name, salt, self.digest(password, salt), role, int(time.time())

    @staticmethod
    def insert_user(conn, values, email=None):
        if conn.execute(
            "SELECT id FROM users WHERE username=?", (values[0],)
        ).fetchone():
            raise ValueError("用户名已被使用")
        return conn.execute(
            "INSERT INTO users(username,child_name,salt,password_hash,role,created,email) VALUES(?,?,?,?,?,?,?)",
            (*values, email),
        ).lastrowid

    def create(self, username, name, password, role="child"):
        values = self.prepare_user(username, name, password, role)
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            return self.insert_user(conn, values)

    @staticmethod
    def public(row):
        return {
            k: row[k]
            for k in ["id", "username", "child_name", "role", "enabled", "created"]
        }

    def user(self, cookie):
        try:
            token = SimpleCookie(cookie or "")["bx_session"].value
        except (KeyError, ValueError):
            return None
        with self.db() as conn:
            row = conn.execute(
                "SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>? AND u.enabled=1",
                (hashlib.sha256(token.encode()).hexdigest(), int(time.time())),
            ).fetchone()
        return self.public(row) if row else None

    def challenge(self):
        answer = "".join(secrets.choice("23456789") for _ in range(4))
        identity = secrets.token_urlsafe(24)
        with self.db() as conn:
            conn.execute("DELETE FROM challenges WHERE expires<?", (int(time.time()),))
            conn.execute(
                "INSERT INTO challenges VALUES(?,?,?)",
                (
                    identity,
                    hashlib.sha256(answer.encode()).hexdigest(),
                    int(time.time()) + 300,
                ),
            )
        image = Image.new("RGB", (180, 58), "#fff7e8")
        draw = ImageDraw.Draw(image)
        try:
            font_path = (
                "C:/Windows/Fonts/arialbd.ttf"
                if os.name == "nt"
                else "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
            )
            font = ImageFont.truetype(font_path, 32)
        except OSError:
            font = ImageFont.load_default(size=30)
        for _ in range(3):
            draw.line(
                (
                    secrets.randbelow(180),
                    secrets.randbelow(58),
                    secrets.randbelow(180),
                    secrets.randbelow(58),
                ),
                fill="#d6c9af",
            )
        for i, c in enumerate(answer):
            draw.text((17 + i * 40, 9), c, font=font, fill="#29465f")
        output = io.BytesIO()
        image.save(output, "PNG")
        return dict(
            id=identity,
            image="data:image/png;base64,"
            + base64.b64encode(output.getvalue()).decode(),
            expiresIn=300,
        )

    def verify(self, body):
        identity, answer = body.get("captchaId", ""), body.get("captcha", "")
        if not isinstance(identity, str) or not isinstance(answer, str):
            raise ValueError("请输入图片验证码")
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM challenges WHERE id=?", (identity,)
            ).fetchone()
            conn.execute("DELETE FROM challenges WHERE id=?", (identity,))
        answer = re.sub(r"\s+", "", unicodedata.normalize("NFKC", answer)).upper()
        if (
            not row
            or row["expires"] < time.time()
            or not hmac.compare_digest(
                row["answer_hash"], hashlib.sha256(answer.encode()).hexdigest()
            )
        ):
            raise ValueError("验证码错误或已过期，请换一张后重试")

    def login(self, body):
        username, password = body.get("username", ""), body.get("password", "")
        if not isinstance(username, str) or not isinstance(password, str):
            raise ValueError("请输入用户名和密码")
        key = username.lower()[:32]
        with self.db() as conn:
            limit = conn.execute(
                "SELECT * FROM login_limits WHERE key=?", (key,)
            ).fetchone()
        if limit and limit["attempts"] >= 5 and limit["until_at"] > time.time():
            raise ValueError("尝试次数过多，请 5 分钟后重试或联系管理员")
        self.verify(body)
        with self.db() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE username=?", (username,)
            ).fetchone()
        valid = (
            row
            and row["enabled"]
            and hmac.compare_digest(
                row["password_hash"], self.digest(password, row["salt"])
            )
        )
        if not valid:
            count = (
                limit["attempts"] + 1
                if limit and limit["until_at"] > time.time()
                else 1
            )
            with self.db() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO login_limits VALUES(?,?,?)",
                    (key, count, int(time.time()) + 300),
                )
            raise ValueError("用户名或密码不正确，或账号已停用")
        token = secrets.token_urlsafe(32)
        with self.db() as conn:
            conn.execute("DELETE FROM login_limits WHERE key=?", (key,))
            conn.execute("DELETE FROM sessions WHERE expires<?", (int(time.time()),))
            added = conn.execute(
                """INSERT INTO sessions(token_hash,user_id,expires)
                   SELECT ?,id,? FROM users WHERE id=? AND password_hash=? AND enabled=1""",
                (
                    hashlib.sha256(token.encode()).hexdigest(),
                    int(time.time()) + 604800,
                    row["id"],
                    row["password_hash"],
                ),
            ).rowcount
            if not added:
                raise ValueError("账号凭据已更新，请重新登录")
        return (
            self.public(row),
            "bx_session="
            + token
            + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800"
            + ("; Secure" if os.environ.get("SECURE_COOKIES") == "1" else ""),
        )

    def logout(self, cookie):
        try:
            token = SimpleCookie(cookie or "")["bx_session"].value
            with self.db() as conn:
                conn.execute(
                    "DELETE FROM sessions WHERE token_hash=?",
                    (hashlib.sha256(token.encode()).hexdigest(),),
                )
        except (KeyError, ValueError):
            pass

    def change_password(self, user, old, new):
        self.validate_password(new)
        if not isinstance(old, str):
            raise ValueError("请填写原密码")
        with self.db() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE id=?", (user["id"],)
            ).fetchone()
            if not hmac.compare_digest(
                row["password_hash"], self.digest(old, row["salt"])
            ):
                raise ValueError("原密码不正确")
            salt = secrets.token_hex(16)
            conn.execute(
                "UPDATE users SET salt=?,password_hash=? WHERE id=?",
                (salt, self.digest(new, salt), user["id"]),
            )
            conn.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))

    def listing(self):
        with self.db() as conn:
            return dict(
                users=[
                    self.public(r)
                    for r in conn.execute("SELECT * FROM users ORDER BY id")
                ],
                requests=[
                    dict(r)
                    for r in conn.execute(
                        "SELECT * FROM reset_requests ORDER BY id DESC LIMIT 100"
                    )
                ],
            )

    def update(self, actor, body):
        uid = body.get("id")
        if type(uid) != int:
            raise ValueError("用户编号不正确")
        with self.db() as conn:
            target = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            if not target:
                raise ValueError("用户不存在")
            name = self.name(body.get("child_name", target["child_name"]))
            username = body.get("username", target["username"])
            if not isinstance(username, str) or not re.fullmatch(
                r"[A-Za-z0-9_]{3,32}", username
            ):
                raise ValueError("用户名格式不正确")
            if conn.execute(
                "SELECT id FROM users WHERE username=? AND id!=?", (username, uid)
            ).fetchone():
                raise ValueError("用户名已被使用")
            role, enabled = (
                body.get("role", target["role"]),
                body.get("enabled", bool(target["enabled"])),
            )
            if role not in ["admin", "child", "parent"] or type(enabled) != bool:
                raise ValueError("角色或状态不正确")
            if (
                role != target["role"]
                and conn.execute(
                    "SELECT 1 FROM family_links WHERE child_id=? OR parent_id=?",
                    (uid, uid),
                ).fetchone()
            ):
                raise ValueError("请先解除家庭绑定，再变更账号角色")
            if uid == actor["id"] and (not enabled or role != "admin"):
                raise ValueError("不能停用或降级当前管理员")
            if (
                target["role"] == "admin"
                and (not enabled or role != "admin")
                and conn.execute(
                    "SELECT COUNT(*) FROM users WHERE role='admin' AND enabled=1"
                ).fetchone()[0]
                <= 1
            ):
                raise ValueError("至少需保留一名可用管理员")
            conn.execute(
                "UPDATE users SET username=?,child_name=?,role=?,enabled=? WHERE id=?",
                (username, name, role, int(enabled), uid),
            )
            if not enabled:
                conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        return dict(ok=True)

    def reset(self, uid):
        password, salt = secrets.token_urlsafe(10), secrets.token_hex(16)
        with self.db() as conn:
            target = conn.execute(
                "SELECT id,username FROM users WHERE id=?", (uid,)
            ).fetchone()
            if not target:
                raise ValueError("用户不存在")
            conn.execute(
                "UPDATE users SET salt=?,password_hash=? WHERE id=?",
                (salt, self.digest(password, salt), uid),
            )
            conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
            conn.execute(
                "UPDATE reset_requests SET status='resolved' WHERE username=?",
                (target["username"],),
            )
        return dict(username=target["username"], temporaryPassword=password)

    def family(self, actor):
        with self.db() as conn:
            if actor["role"] == "child":
                rows = conn.execute(
                    "SELECT u.* FROM users u JOIN family_links f ON u.id=f.parent_id WHERE f.child_id=? AND u.role='parent'",
                    (actor["id"],),
                )
                return dict(parents=[self.public(r) for r in rows], children=[])
            if actor["role"] == "parent":
                rows = conn.execute(
                    "SELECT u.* FROM users u JOIN family_links f ON u.id=f.child_id WHERE f.parent_id=? AND u.role='child' AND u.enabled=1 ORDER BY u.id",
                    (actor["id"],),
                )
                return dict(parents=[], children=[self.public(r) for r in rows])
        return dict(parents=[], children=[])

    def register_parent(self, actor, body):
        if actor["role"] != "child":
            raise PermissionError("请从宝宝账号的个人中心注册家长")
        values = self.prepare_user(
            body.get("username"),
            body.get("display_name"),
            body.get("password"),
            "parent",
        )
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            parent_id = self.insert_user(conn, values)
            self.link_parent(conn, actor["id"], parent_id)
        return dict(ok=True)

    @staticmethod
    def link_parent(conn, child_id, parent_id, parent_hash=None):
        linked = conn.execute(
            """INSERT INTO family_links(child_id,parent_id,created)
               SELECT child.id,parent.id,?
               FROM users AS child JOIN users AS parent ON parent.id=?
               WHERE child.id=? AND child.role='child' AND child.enabled=1
                 AND parent.role='parent' AND parent.enabled=1
                 AND (? IS NULL OR parent.password_hash=?)
               ON CONFLICT(child_id,parent_id) DO UPDATE SET created=family_links.created""",
            (int(time.time()), parent_id, child_id, parent_hash, parent_hash),
        ).rowcount
        if not linked:
            raise PermissionError("宝宝或家长账号当前不可用，请重新核验")

    def bind_parent(self, actor, body):
        if actor["role"] != "child":
            raise PermissionError("请从宝宝账号绑定家长")
        username, password = body.get("username"), body.get("password")
        if (
            not isinstance(username, str)
            or not isinstance(password, str)
            or len(password) > 128
        ):
            raise ValueError("请填写家长用户名和密码")
        key = "family:" + str(actor["id"])
        with self.db() as conn:
            limit = conn.execute(
                "SELECT * FROM login_limits WHERE key=?", (key,)
            ).fetchone()
            if limit and limit["attempts"] >= 5 and limit["until_at"] > time.time():
                raise ValueError("核验次数过多，请五分钟后重试")
            row = conn.execute(
                "SELECT * FROM users WHERE username=? AND role='parent' AND enabled=1",
                (username,),
            ).fetchone()
        if not row or not hmac.compare_digest(
            row["password_hash"], self.digest(password, row["salt"])
        ):
            count = (
                limit["attempts"] + 1
                if limit and limit["until_at"] > time.time()
                else 1
            )
            with self.db() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO login_limits VALUES(?,?,?)",
                    (key, count, int(time.time()) + 300),
                )
            raise ValueError("家长用户名或密码不正确，或账号不可用")
        with self.db() as conn:
            self.link_parent(conn, actor["id"], row["id"], row["password_hash"])
            conn.execute("DELETE FROM login_limits WHERE key=?", (key,))
        return dict(ok=True)

    def unlink(self, actor, target):
        if type(target) != int or actor["role"] not in ["child", "parent"]:
            raise PermissionError("不能操作这条绑定")
        with self.db() as conn:
            if actor["role"] == "child":
                conn.execute(
                    "DELETE FROM family_links WHERE child_id=? AND parent_id=?",
                    (actor["id"], target),
                )
            else:
                conn.execute(
                    "DELETE FROM family_links WHERE child_id=? AND parent_id=?",
                    (target, actor["id"]),
                )
        return dict(ok=True)

    def learning_owner(self, actor, child_id=None):
        if actor["role"] != "parent":
            return actor
        children = self.family(actor)["children"]
        if child_id is None and children:
            return children[0]
        for child in children:
            if str(child["id"]) == str(child_id):
                return child
        raise PermissionError("没有访问这个宝宝学习记录的权限，或尚未绑定宝宝")
