"""One-time mailbox verification per account and purpose."""

import hashlib
import hmac
import logging
import os
import re
import secrets
import smtplib
import time

LOG = logging.getLogger(__name__)
CODE_TTL = 600
RESEND_SECONDS = 60
MAX_ATTEMPTS = 5
REGISTER = {"register": "child", "register-parent": "parent"}
EMAIL_PATTERN = re.compile(
    r"[a-z0-9!#$%&'*+/=?^_{}|~.-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+",
    re.ASCII,
)


class RegistrationUnavailable(ValueError):
    def __init__(self):
        super().__init__("邮件服务暂未配置，注册已暂停。请联系管理员。")


def normalize_email(value):
    if not isinstance(value, str):
        raise ValueError("请填写有效的邮箱地址")
    email = value.strip().lower()
    local = email.split("@", 1)[0]
    if not (len(email) <= 254 and len(local) <= 64 and EMAIL_PATTERN.fullmatch(email)):
        raise ValueError("请填写有效的邮箱地址")
    if ".." in local or local.startswith(".") or local.endswith("."):
        raise ValueError("请填写有效的邮箱地址")
    return email


def verification_secret(path):
    # Separate from the mail credential so rotating the sender keeps verification independent.
    if not path.exists():
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "wb") as target:
                target.write(secrets.token_bytes(32))
    secret = path.read_bytes()
    if len(secret) != 32:
        raise ValueError("邮件验证私有密钥文件无效")
    return secret


class EmailVerification:
    def __init__(self, db, accounts, mailer, secret, clock=time.time):
        self.db, self.accounts, self.mailer, self.secret, self.clock = (
            db,
            accounts,
            mailer,
            secret,
            clock,
        )
        with self.db() as conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS email_codes (
                email TEXT NOT NULL, purpose TEXT NOT NULL, username TEXT NOT NULL,
                digest TEXT NOT NULL, issued_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL CHECK(attempts >= 0),
                PRIMARY KEY(email, purpose, username)
            )""")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS email_codes_by_time ON email_codes(issued_at)"
            )

    @staticmethod
    def _scope(action, actor):
        if action == "family":
            if not actor or actor["role"] != "child":
                raise PermissionError("请从宝宝账号的家庭绑定页面操作")
            return "family:" + str(actor["id"])
        if action in (*REGISTER, "reset"):
            return action
        raise ValueError("验证码用途不正确")

    def _inputs(self, body, actor):
        action = body.get("purpose")
        purpose = self._scope(action, actor)
        username = self.accounts.username(body.get("username"))
        return (
            action,
            (normalize_email(body.get("email")), purpose, username.lower()),
            username,
        )

    def _digest(self, key, code):
        return hmac.new(
            self.secret, "\0".join((*key, code)).encode(), hashlib.sha256
        ).hexdigest()

    @staticmethod
    def _check_limit(conn, kind, address, now, maximum):
        key = f"mail-{kind}:" + hashlib.sha256(address.encode()).hexdigest()
        limit = conn.execute(
            "SELECT attempts,until_at FROM login_limits WHERE key=?", (key,)
        ).fetchone()
        count, end = (
            (limit["attempts"], limit["until_at"])
            if limit and limit["until_at"] > now
            else (0, now + CODE_TTL)
        )
        if count >= maximum:
            raise ValueError("请求次数较多，请稍后再试")
        conn.execute(
            """INSERT INTO login_limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE
                        SET attempts=excluded.attempts, until_at=excluded.until_at""",
            (key, count + 1, end),
        )

    def send(self, body, actor, ip):
        action, key, _ = self._inputs(body, actor)
        if not self.mailer.enabled:
            if action != "reset":
                raise RegistrationUnavailable()
            raise ValueError("邮件服务暂未开启，请联系管理员")
        self.accounts.verify(body)
        now = int(self.clock())
        code = f"{secrets.randbelow(1_000_000):06d}"
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "DELETE FROM email_codes WHERE issued_at<=?", (now - CODE_TTL,)
            )
            conn.execute(
                "DELETE FROM login_limits WHERE key GLOB 'mail-*' AND until_at<=?",
                (now,),
            )
            if conn.execute(
                """SELECT 1 FROM email_codes
                WHERE email=? AND purpose=? AND username=? AND issued_at>?""",
                (*key, now - RESEND_SECONDS),
            ).fetchone():
                raise ValueError("验证码刚发出，请等 60 秒后再试")
            self._check_limit(conn, "ip", ip, now, 12)
            self._check_limit(conn, "box", key[0], now, 6)
            eligible = action != "reset" or bool(self._reset_target(conn, key))
            conn.execute(
                """INSERT INTO email_codes VALUES(?,?,?,?,?,0)
                ON CONFLICT(email,purpose,username) DO UPDATE
                SET digest=excluded.digest,issued_at=excluded.issued_at,attempts=0""",
                (*key, self._digest(key, code) if eligible else "", now),
            )
        if eligible:
            try:
                self.mailer.send_code(
                    key[0],
                    code,
                    reset=action == "reset",
                    expires_minutes=CODE_TTL // 60,
                )
            except (OSError, smtplib.SMTPException):
                LOG.warning("Verification mail delivery failed")
                with self.db() as conn:
                    conn.execute(
                        "UPDATE email_codes SET digest='' WHERE email=? AND purpose=? AND username=? AND issued_at=?",
                        (*key, now),
                    )
                if action != "reset":
                    raise ValueError("验证码暂未发出，请稍后重试") from None
        message = (
            "如果用户名和邮箱匹配，验证码将发到该邮箱。"
            if action == "reset"
            else "验证码已发送，请查看邮箱。"
        )
        return {"message": message}

    @staticmethod
    def _reset_target(conn, key):
        return conn.execute(
            """SELECT id FROM users WHERE username=? AND email=? AND enabled=1 AND role IN ('child','parent')""",
            (key[2], key[0]),
        ).fetchone()

    def _verify(self, conn, key, code, now):
        row = conn.execute(
            "SELECT * FROM email_codes WHERE email=? AND purpose=? AND username=?", key
        ).fetchone()
        if (
            not row
            or not row["digest"]
            or row["issued_at"] + CODE_TTL <= now
            or row["attempts"] >= MAX_ATTEMPTS
        ):
            return False
        if hmac.compare_digest(row["digest"], self._digest(key, code)):
            conn.execute(
                "UPDATE email_codes SET digest='' WHERE email=? AND purpose=? AND username=?",
                key,
            )
            return True
        conn.execute(
            "UPDATE email_codes SET attempts=attempts+1 WHERE email=? AND purpose=? AND username=?",
            key,
        )
        return False

    def complete(self, body, actor):
        action, key, username = self._inputs(body, actor)
        if action != "reset" and not self.mailer.enabled:
            raise RegistrationUnavailable()
        code = body.get("emailCode", "")
        if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code.strip()):
            raise ValueError("请输入邮件里的 6 位数字验证码")
        password = body.get("password")
        if action == "reset":
            self.accounts.validate_password(password)
            salt = secrets.token_hex(16)
            digest = self.accounts.digest(password, salt)
        else:
            role = "parent" if action == "family" else REGISTER[action]
            values = self.accounts.prepare_user(
                username, body.get("child_name"), password, role
            )
        now = int(self.clock())
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            verified = self._verify(conn, key, code.strip(), now)
            if verified and action == "reset":
                target = self._reset_target(conn, key)
                if target:
                    conn.execute(
                        "UPDATE users SET salt=?,password_hash=? WHERE id=?",
                        (salt, digest, target["id"]),
                    )
                    conn.execute(
                        "DELETE FROM sessions WHERE user_id=?", (target["id"],)
                    )
                verified = bool(target)
            elif verified:
                uid = self.accounts.insert_user(conn, values, key[0])
                if action == "family":
                    self.accounts.link_parent(conn, actor["id"], uid)
        if not verified:
            raise ValueError("验证码不正确、已过期或已使用，请重新获取")
        return {"ok": True, "username": username}
