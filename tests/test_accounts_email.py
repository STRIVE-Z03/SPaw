import hashlib
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from test_learning import ROOT
from backend.identity.accounts import Accounts
from backend.identity.email_verification import EmailVerification, MAX_ATTEMPTS
from backend.identity.mail import QQMailer
from backend.storage.database import database


class Inbox:
    enabled = True

    def __init__(self):
        self.received = []

    def send_code(self, address, code, **options):
        self.received.append((address, code, options))


class EmailAccountsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.db = database(self.directory / "accounts.sqlite3")
        self.accounts = Accounts(self.db, self.directory)
        self.mail = Inbox()
        self.now = 1000
        self.verifier = EmailVerification(
            self.db, self.accounts, self.mail, b"v" * 32, lambda: self.now
        )
        self.mailbox = "SAME@example.com"
        self.counter = 0

    def request(self, purpose, username, *, email=None, actor=None):
        self.counter += 1
        captcha = {"captchaId": f"email-test-{self.counter}", "captcha": "1234"}
        with self.db() as conn:
            conn.execute(
                "INSERT INTO challenges VALUES(?,?,?)",
                (
                    captcha["captchaId"],
                    hashlib.sha256(b"1234").hexdigest(),
                    int(time.time()) + 120,
                ),
            )
        data = {
            "purpose": purpose,
            "username": username,
            "email": email or self.mailbox,
            **captcha,
        }
        self.verifier.send(data, actor, "127.0.0.1")
        return data

    def actor(self, username):
        with self.db() as conn:
            return self.accounts.public(
                conn.execute(
                    "SELECT * FROM users WHERE username=?", (username,)
                ).fetchone()
            )

    def register(self, username, purpose="register", actor=None, code=888888):
        with patch(
            "backend.identity.email_verification.secrets.randbelow", return_value=code
        ):
            body = self.request(purpose, username, actor=actor)
        body.update(
            emailCode=f"{code:06d}", child_name="测试", password="original-pass"
        )
        return self.verifier.complete(body, actor)

    def test_same_email_child_and_family_keeps_distinct_accounts_and_reset(self):
        self.register("student_alpha", code=123456)
        child = self.actor("student_alpha")
        self.register("guardian_alpha", purpose="family", actor=child, code=654321)
        with self.assertRaisesRegex(ValueError, "60 秒"):
            self.request("family", "guardian_alpha", actor=child)
        guardian = self.actor("guardian_alpha")
        self.assertNotEqual(child["id"], guardian["id"])
        self.assertEqual(
            [r["id"] for r in self.accounts.family(guardian)["children"]], [child["id"]]
        )
        with self.db() as conn:
            self.assertEqual(
                [
                    row[0]
                    for row in conn.execute(
                        "SELECT email FROM users WHERE email IS NOT NULL ORDER BY id"
                    )
                ],
                ["same@example.com", "same@example.com"],
            )
            conn.execute(
                "INSERT INTO user_state VALUES(?,?,?)",
                (child["id"], 1, '{"points":26}'),
            )
            conn.executemany(
                "INSERT INTO sessions VALUES(?,?,?)",
                (
                    ("child-session", child["id"], 10000),
                    ("parent-session", guardian["id"], 10000),
                ),
            )
            parent_hash = conn.execute(
                "SELECT password_hash FROM users WHERE id=?", (guardian["id"],)
            ).fetchone()[0]
        with patch(
            "backend.identity.email_verification.secrets.randbelow", return_value=374001
        ):
            reset = self.request("reset", "student_alpha")
        reset.update(emailCode="374001", password="replacement-pass")
        with self.assertRaises(ValueError):
            self.verifier.complete({**reset, "username": "guardian_alpha"}, None)
        self.verifier.complete(reset, None)
        with self.assertRaises(ValueError):
            self.verifier.complete(reset, None)
        with self.db() as conn:
            student = conn.execute(
                "SELECT * FROM users WHERE id=?", (child["id"],)
            ).fetchone()
            self.assertEqual(
                self.accounts.digest("replacement-pass", student["salt"]),
                student["password_hash"],
            )
            self.assertEqual(
                conn.execute(
                    "SELECT value FROM user_state WHERE user_id=?", (child["id"],)
                ).fetchone()[0],
                '{"points":26}',
            )
            self.assertEqual(
                conn.execute(
                    "SELECT password_hash FROM users WHERE id=?", (guardian["id"],)
                ).fetchone()[0],
                parent_hash,
            )
            self.assertEqual(
                [row[0] for row in conn.execute("SELECT token_hash FROM sessions")],
                ["parent-session"],
            )
        self.assertEqual(
            [r["id"] for r in self.accounts.family(guardian)["children"]], [child["id"]]
        )

    def test_legacy_family_link_migrates_without_changing_binding(self):
        child = self.accounts.create("legacy_child", "宝宝", "test-password")
        parent = self.accounts.create(
            "legacy_parent", "家长", "test-password", "parent"
        )
        with self.db() as conn:
            conn.execute("DROP TABLE family_links")
            conn.execute("""CREATE TABLE family_links (
                child_id INTEGER NOT NULL, parent_id INTEGER NOT NULL,
                created INTEGER NOT NULL, PRIMARY KEY(child_id,parent_id)
            )""")
            conn.execute(
                "INSERT INTO family_links VALUES(?,?,?)", (child, parent, 1234)
            )
        Accounts(self.db, self.directory)
        with self.db() as conn:
            row = conn.execute("SELECT * FROM family_links").fetchone()
            self.assertEqual(tuple(row), (child, parent, 1234))
        with self.assertRaises(sqlite3.IntegrityError), self.db() as conn:
            conn.execute("INSERT INTO family_links VALUES(?,?,?)", (9999, parent, 1234))

    def test_expired_code_wrong_role_other_child_and_attempt_limit(self):
        self.register("child_one")
        self.now += 61
        self.register("child_two")
        first, other = self.actor("child_one"), self.actor("child_two")
        self.now += 61
        with patch(
            "backend.identity.email_verification.secrets.randbelow", return_value=738321
        ):
            body = self.request("family", "parent_one", actor=first)
        body.update(emailCode="738321", child_name="家长", password="new-password")
        with self.assertRaises(ValueError):
            self.verifier.complete(body, other)
        with self.assertRaises(ValueError):
            self.verifier.complete({**body, "purpose": "register-parent"}, None)
        for _ in range(MAX_ATTEMPTS):
            with self.assertRaises(ValueError):
                self.verifier.complete({**body, "emailCode": "000000"}, first)
        with self.assertRaises(ValueError):
            self.verifier.complete(body, first)
        self.now += 61
        with patch(
            "backend.identity.email_verification.secrets.randbelow", return_value=100011
        ):
            body = self.request("register", "child_expired")
        self.now += 600
        with self.assertRaises(ValueError):
            self.verifier.complete(
                {
                    **body,
                    "emailCode": "100011",
                    "child_name": "孩子",
                    "password": "long-pass",
                },
                None,
            )

    def test_qq_email_multipart_uses_cid_and_plain_text(self):
        class Connection:
            def __init__(self):
                self.message = None

            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

            def login(self, username, password):
                assert username == "test@qq.com" and password == "fixture-only"

            def send_message(self, message):
                self.message = message

        fixture = Connection()
        transport = QQMailer(
            {
                "PAW_SMTP_ADDRESS": "test@qq.com",
                "PAW_SMTP_AUTHORIZATION": "fixture-only",
            },
            ROOT / "app/assets/brand/paw-mascot.png",
            lambda *_a, **_k: fixture,
        )
        transport.send_code(
            "family@example.com", "040721", reset=True, expires_minutes=10
        )
        message = fixture.message
        self.assertIn("040721", message.get_body(("plain",)).get_content())
        self.assertIn("cid:paw-mascot", message.get_body(("html",)).get_content())
        self.assertTrue(
            any(part["Content-ID"] == "<paw-mascot>" for part in message.walk())
        )
        self.assertNotIn("fixture-only", message.as_string())
