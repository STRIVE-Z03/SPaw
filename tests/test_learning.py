import base64
import hashlib
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from PIL import Image
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))
from backend.agent.teaching_tools import TeachingTools
from backend.agent.teaching_tools import TEXTBOOK_TOOL
from backend.agent.provider_router import ProviderRouter
from backend.agent.tutor import TutorAgent
from backend.identity.accounts import Accounts
from backend.storage.database import database
from backend.storage.learning import PracticeRepository


class LearningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.data = Path(cls.temp.name) / "data"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        cls.url = f"http://127.0.0.1:{port}"
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(("BANXUEPAW_", "AI_", "TAVILY_", "PAW_PRACTICE_AI_"))
        }
        env.update(
            BANXUEPAW_DATA_DIR=str(cls.data),
            BANXUEPAW_MATERIALS_DIR=str(ROOT / "教材"),
            BANXUEPAW_ENV_FILE=str(cls.data / "unused.env"),
            PORT=str(port),
        )
        log = Path(cls.temp.name, "server.log").open("wb")
        cls.addClassCleanup(log.close)
        proc = subprocess.Popen(
            [sys.executable, str(ROOT / "app/server.py")],
            env=env,
            stdout=log,
            stderr=log,
        )
        cls.addClassCleanup(lambda: proc.wait(timeout=8))
        cls.addClassCleanup(proc.terminate)
        for _ in range(80):
            try:
                cls.call("/api/health", None)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError(Path(cls.temp.name, "server.log").read_text())
        db = database(cls.data / "learning.sqlite3")
        accounts = Accounts(db, cls.data)
        cls.alpha = cls.session(db, accounts, "testalpha")
        cls.beta = cls.session(db, accounts, "testbeta")
        cls.adaptive = cls.session(db, accounts, "adaptivecheck")
        with db() as conn:
            now = int(time.time())
            conn.execute(
                """INSERT INTO memberships(user_id,tier,starts,expires)
                SELECT id,'vip',?,? FROM users WHERE username='adaptivecheck'""",
                (now, now + 3600),
            )
        token = "notice-test-admin-session"
        with db() as conn:
            uid = conn.execute(
                "SELECT id FROM users WHERE username='admin'"
            ).fetchone()[0]
            conn.execute(
                "INSERT INTO sessions VALUES(?,?,?)",
                (
                    hashlib.sha256(token.encode()).hexdigest(),
                    uid,
                    int(time.time()) + 3600,
                ),
            )
        cls.admin = "bx_session=" + token

    @staticmethod
    def session(db, accounts, name):
        uid = accounts.create(name, "测试学生", "test-password-only")
        token = name + "-isolated-test-session"
        with db() as conn:
            conn.execute(
                "INSERT INTO sessions VALUES (?,?,?)",
                (
                    hashlib.sha256(token.encode()).hexdigest(),
                    uid,
                    int(time.time()) + 3600,
                ),
            )
        return "bx_session=" + token

    @classmethod
    def call(cls, path, cookie, body=None, *, parse=True):
        headers = {"Cookie": cookie} if cookie else {}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        with urlopen(
            Request(cls.url + path, data=data, headers=headers), timeout=20
        ) as res:
            raw = res.read()
            return json.loads(raw) if parse else raw

    @unittest.skipUnless(
        (ROOT / "app/arena-data.bwa").is_file()
        and (ROOT / "app/content/arena/practice-reviews.json").is_file(),
        "此联调用例需要本地竞技场样本和复核索引",
    )
    def test_adaptive_arena_report_uses_ten_distinct_questions_and_fresh_results(self):
        from itertools import permutations

        cookie = self.adaptive
        reviews = json.loads(
            (ROOT / "app/content/arena/practice-reviews.json").read_text()
        )

        def rounded_count(digits, target):
            return sum(
                (int("".join(p)) + 5000) // 10000 == target
                for p in permutations(digits)
            )

        answers = {
            key.split(":")[-1]: data["answer"][0] for key, data in reviews.items()
        }
        self.assertEqual(int(answers["49fdcbe1f5b3"]), rounded_count("12578", 5))
        self.assertEqual(int(answers["2a4356f62070"]), rounded_count("167935", 36))

        def create(style, key, topic="adaptive"):
            return self.call(
                "/api/learning/practice",
                cookie,
                {
                    "style": style,
                    "topicId": topic,
                    "grade": 4,
                    "requestId": key,
                },
            )

        def submit(practice, question, wrong=False):
            answer = reviews[question["originId"]]["answer"]
            if question["kind"] == "choice":
                answer = (
                    next(key for key in question["optionIds"] if key != answer[0])
                    if wrong
                    else answer[0]
                )
            elif wrong:
                answer = ["0"] * len(answer)
            return self.call(
                "/api/learning/attempts",
                cookie,
                {
                    "setId": practice["id"],
                    "questionId": question["id"],
                    "answer": answer,
                    "elapsed": 7,
                },
            )

        paper = create("arena-paper", "adaptive-report-paper", "math:多位数乘法")
        self.assertEqual(len(paper["questions"]), 10)
        originals = {q["originId"] for q in paper["questions"]}
        self.assertEqual(len(originals), 10)
        self.assertTrue(originals <= reviews.keys())
        self.assertEqual({q["kind"] for q in paper["questions"]}, {"choice", "written"})
        self.assertTrue(all("answer" not in q for q in paper["questions"]))
        image_set = create("arena-paper", "adaptive-review-image", "math:角的度量")
        image_url = next(
            q["images"][0] for q in image_set["questions"] if q.get("images")
        )
        self.assertGreater(len(self.call(image_url, cookie, parse=False)), 1000)
        with self.assertRaises(HTTPError) as denied:
            self.call(image_url, self.beta, parse=False)
        self.assertEqual(denied.exception.code, 403)

        for q in paper["questions"][:9]:
            self.assertTrue(submit(paper, q)["correct"])
        dashboard = self.call("/api/learning/dashboard", cookie)
        self.assertEqual(dashboard["analysis"]["graded"], 9)
        self.assertEqual(dashboard["analysis"]["threshold"], 10)
        self.assertTrue(submit(paper, paper["questions"][-1])["correct"])

        q = paper["questions"][0]
        answer = reviews[q["originId"]]["answer"]
        job = self.call(
            f"/api/arena/questions/{q['originId']}/check",
            cookie,
            {
                "answer": answer[0] if q["kind"] == "choice" else ",".join(answer),
                "intent": "check",
                "requestId": "same-arena-question-check",
            },
        )
        for _ in range(30):
            value = self.call(f"/api/study/jobs/{job['job']['id']}", cookie)
            if value["status"] == "done":
                break
            self.assertNotEqual(value["status"], "error")
            time.sleep(0.05)
        else:
            self.fail("竞技场核对未完成")

        dashboard = self.call("/api/learning/dashboard", cookie)
        analysis = dashboard["analysis"]
        self.assertEqual((analysis["graded"], analysis["correct"]), (10, 10))
        self.assertTrue(any(row["source"] == "竞技场" for row in analysis["items"]))
        self.assertTrue(any(row["elapsed"] == 7 for row in analysis["items"]))
        self.assertEqual(
            {item["graded"] for item in analysis["subjects"] if item["id"] != "math"},
            {0},
        )
        self.assertEqual(
            create("arena-paper", "adaptive-report-paper"),
            self.call("/api/learning/practice/" + paper["id"], cookie),
        )

        adjusted = self.call(
            "/api/learning/next-practice",
            cookie,
            {
                "setId": paper["id"],
                "requestId": "adaptive-report-next",
            },
        )
        self.assertGreater(len(adjusted["questions"]), len(paper["questions"]))
        self.assertGreater(
            sum(q["difficulty"] != "basic" for q in adjusted["questions"]),
            sum(q["difficulty"] != "basic" for q in paper["questions"]),
        )
        self.assertTrue({q["originId"] for q in adjusted["questions"]} - originals)
        selected = next(p for p in dashboard["points"] if p["status"] == "mastered")
        from urllib.parse import quote

        details = self.call(
            "/api/learning/records?point=" + quote(selected["id"]), cookie
        )
        self.assertTrue(details["items"])
        self.assertTrue(
            all(row["pointId"] == selected["id"] for row in details["items"])
        )
        again = create("arena-paper", "adaptive-report-retake", selected["id"])
        for q in again["questions"]:
            if q["pointId"] == selected["id"]:
                self.assertFalse(submit(again, q, wrong=True)["correct"])
        summary = self.call("/api/learning/dashboard", cookie)
        point = next(p for p in summary["points"] if p["id"] == selected["id"])
        self.assertEqual(point["status"], "needs-practice")

    def test_catalog_lesson_and_reader(self):
        initial = self.call("/api/learning/dashboard", self.alpha)
        if not initial["books"]:
            self.skipTest("此联调用例需要本地教材样本")
        self.assertFalse(any(book["subject"] == "science" for book in initial["books"]))
        book = initial["books"][0]["id"]
        lesson = self.call(
            "/api/learning/lesson?topicId=decimal&bookId=" + book, self.alpha
        )
        self.assertEqual(lesson["diagram"]["groups"], [3, 7])
        self.assertGreaterEqual(len({r["page"] for r in lesson["references"]}), 2)
        for ref in lesson["references"]:
            self.assertEqual(ref["url"], f"/#/reader/{book}/{ref['page']}")
            self.assertTrue(
                self.call(
                    f"/api/books/{book}/page?n={ref['page']}", self.alpha, parse=False
                ).startswith(b"\xff\xd8")
            )
        with self.assertRaises(HTTPError) as context:
            self.call("/api/learning/dashboard", None)
        self.assertEqual(context.exception.code, 401)

    def test_duplicate_requests_and_student_boundary(self):
        request = {"topicId": "addition", "requestId": "addition-concurrency"}
        with ThreadPoolExecutor(6) as pool:
            sets = list(
                pool.map(
                    lambda _: self.call("/api/learning/practice", self.alpha, request),
                    range(6),
                )
            )
        practice = sets[0]
        self.assertEqual({item["id"] for item in sets}, {practice["id"]})
        self.assertTrue(all("answer" not in q for q in practice["questions"]))
        for question in practice["questions"]:
            data = {
                "setId": practice["id"],
                "questionId": question["id"],
                "answer": "0",
            }
            result = self.call("/api/learning/attempts", self.alpha, data)
            self.assertFalse(result["correct"])
            self.assertEqual(
                result, self.call("/api/learning/attempts", self.alpha, data)
            )
        profile = self.call("/api/learning/dashboard", self.alpha)
        self.assertIn(
            ("addition", "needs-practice", 5),
            [(p["id"], p["status"], p["samples"]) for p in profile["points"]],
        )
        with self.assertRaises(HTTPError) as error:
            self.call("/api/learning/practice/" + practice["id"], self.beta)
        self.assertEqual(error.exception.code, 403)

    def test_admin_secrets_written_to_env_and_never_returned(self):
        from backend.storage.environment import Environment, PROVIDER_CONFIG

        route = "/api/admin/ai/tavily"
        self.assertEqual(
            self.call(route, self.admin), {"configured": False, "readOnly": False}
        )
        self.assertFalse(self.call(route, self.admin, {"action": "test"})["ok"])
        fixture_key = "tvly-" + "pytest-only-key"
        with self.assertRaises(HTTPError) as denied:
            self.call(route, self.alpha, {"action": "save", "apiKey": fixture_key})
        self.assertEqual(denied.exception.code, 403)
        saved = self.call(route, self.admin, {"action": "save", "apiKey": fixture_key})
        self.assertEqual(saved, {"configured": True, "readOnly": False})
        environment = Environment(self.data / "unused.env")
        self.assertEqual(environment.get("TAVILY_API_KEY"), fixture_key)
        self.assertEqual(environment.path.stat().st_mode & 0o777, 0o600)

        model_key = "local-test-model-key"
        response = self.call(
            "/api/admin/ai/providers",
            self.admin,
            {
                "providers": [
                    {
                        "id": "primary",
                        "enabled": False,
                        "baseUrl": "https://example.com/v1",
                        "apiKey": model_key,
                    }
                ],
            },
        )
        self.assertNotIn(model_key, json.dumps(response))
        self.assertTrue(response["providers"][0]["hasKey"])
        self.assertIn(model_key, environment.get(PROVIDER_CONFIG))
        with database(self.data / "learning.sqlite3")() as conn:
            self.assertIsNone(
                conn.execute(
                    "SELECT value FROM kv WHERE key='ai-providers-v1'"
                ).fetchone()
            )
        self.assertFalse(
            self.call(route, self.admin, {"action": "save", "apiKey": ""})["configured"]
        )
        self.assertIn(model_key, environment.get(PROVIDER_CONFIG))

    def test_material_packs_are_admin_only(self):
        identity = "a123456789abcdef"
        root = self.data / "material-packs" / identity
        root.mkdir(parents=True)
        (root / "index.json").write_text(
            json.dumps(
                {
                    "id": identity,
                    "title": "教材样本",
                    "count": 2,
                    "reviewed": 0,
                }
            )
        )
        (root / "reader.pdf").write_bytes(b"%PDF-1.7\nfixture")
        (root / "markdown.zip").write_bytes(b"PKfixture")
        route = "/api/admin/material-packs"
        for path in (route, f"{route}/{identity}/pdf", f"{route}/{identity}/bundle"):
            with self.assertRaises(HTTPError) as denied:
                self.call(path, self.beta)
            self.assertEqual(denied.exception.code, 403)
        self.assertEqual(self.call(route, self.admin)["items"][0]["title"], "教材样本")
        self.assertTrue(
            self.call(f"{route}/{identity}/pdf", self.admin, parse=False).startswith(
                b"%PDF"
            )
        )
        self.assertTrue(
            self.call(f"{route}/{identity}/bundle", self.admin, parse=False).startswith(
                b"PK"
            )
        )

    def test_notices_http_crud_and_read_counts(self):
        identity = uuid.uuid4().hex
        title = "测试通知"
        body = "第一段内容。\n\n" + "这是一段很长的通知内容，需要分开阅读。" * 35
        image = io.BytesIO()
        Image.new("RGB", (32, 24), "#3388cc").save(image, "PNG")
        data = {
            "requestId": identity,
            "title": title,
            "body": body,
            "image": "data:image/png;base64,"
            + base64.b64encode(image.getvalue()).decode(),
        }
        path = "/api/admin/notifications"
        with self.assertRaises(HTTPError) as denied:
            self.call(path, self.alpha, data)
        self.assertEqual(denied.exception.code, 403)
        with ThreadPoolExecutor(max_workers=2) as executor:
            publishes = [
                executor.submit(self.call, path, self.admin, data) for _ in range(2)
            ]
            self.assertEqual(
                [request.result()["id"] for request in publishes], [identity, identity]
            )
        self.assertEqual(
            self.call("/api/notifications/unread", self.alpha)["unread"], 1
        )
        self.assertEqual(self.call("/api/notifications", self.alpha)["unread"], 1)
        self.assertEqual(self.call(path + "/" + identity, self.admin)["body"], body)
        ref = "/api/notifications/" + identity
        with ThreadPoolExecutor(max_workers=2) as executor:
            reads = [
                executor.submit(self.call, ref + "/read", self.alpha, {})
                for _ in range(2)
            ]
            notice, replay = [request.result() for request in reads]
        self.assertEqual(notice["unread"], 0)
        self.assertGreater(len(notice["paragraphs"]), 2)
        self.assertEqual(replay["unread"], 0)
        self.assertEqual(self.call("/api/notifications/unread", self.beta)["unread"], 1)
        self.assertEqual(
            self.call(notice["imageUrl"], self.beta, parse=False)[:4], b"RIFF"
        )
        self.call(
            path + "/" + identity + "/edit",
            self.admin,
            {"title": "改过的通知", "body": "更正后的正文。"},
        )
        self.assertEqual(
            self.call("/api/notifications", self.alpha)["items"][0]["title"],
            "改过的通知",
        )
        self.assertEqual(
            self.call("/api/notifications/unread", self.alpha)["unread"], 0
        )
        self.call(path + "/" + identity + "/delete", self.admin, {})
        self.assertEqual(self.call("/api/notifications/unread", self.beta)["unread"], 0)

    def test_guided_practice_formats_and_scoped_tutor(self):
        practice = self.call(
            "/api/learning/practice",
            self.alpha,
            {
                "topicId": "decimal",
                "requestId": "guided-practice-mixed",
                "style": "guided",
            },
        )
        questions = practice["questions"]
        self.assertEqual(
            [q["kind"] for q in questions], ["choice"] * 3 + ["written"] * 2
        )
        self.assertEqual(len(set(questions[0]["options"])), 4)
        self.assertEqual(practice["reviews"], {})
        self.assertTrue(all("expected" not in q for q in questions))
        item = questions[3]
        attempt = {
            "setId": practice["id"],
            "questionId": item["id"],
            "answer": ["0", "0"],
        }
        books = self.call("/api/learning/dashboard", self.alpha)["books"]
        if not books:
            self.skipTest("此联调用例需要本地教材样本")
        book = books[0]["id"]
        context = {
            "practiceSetId": practice["id"],
            "practiceItemId": item["id"],
            "bookId": book,
        }
        create = {
            "clientId": "guided-test-session",
            "kind": "practice",
            "context": context,
        }
        with self.assertRaises(HTTPError) as denied:
            self.call("/api/study/sessions", self.beta, create)
        self.assertEqual(denied.exception.code, 403)
        session = self.call("/api/study/sessions", self.alpha, create)
        endpoint = f"/api/study/sessions/{session['id']}"
        job = self.call(
            endpoint + "/jobs",
            self.alpha,
            {
                "requestId": "guided-test-hint",
                "prompt": "请给我一个提示",
                "practiceWork": {
                    "scratch": "我把个数写成米数了。",
                    "answers": ["0", "0"],
                },
            },
        )
        self.call(f"/api/study/jobs/{job['id']}/events", self.alpha, parse=False)
        messages = self.call(endpoint, self.alpha)["messages"]
        self.assertEqual(messages[0]["data"]["scratch"], "我把个数写成米数了。")
        reply = messages[-1]
        self.assertIn("先把两条彩带", reply["content"])
        self.assertTrue(reply["data"]["references"])
        self.assertEqual(reply["data"]["supportMode"], "local")
        result = self.call("/api/learning/attempts", self.alpha, attempt)
        self.assertFalse(result["correct"])
        self.assertEqual(len(result["review"]["steps"]), 2)
        saved = self.call("/api/learning/practice/" + practice["id"], self.alpha)
        self.assertEqual(saved["reviews"][item["id"]], result["review"])
        self.assertEqual(
            self.call("/api/learning/attempts", self.alpha, attempt), result
        )

    def test_paper_and_next_set_target_graded_weakness(self):
        paper = self.call(
            "/api/learning/practice",
            self.beta,
            {
                "topicId": "decimal",
                "requestId": "paper-test-first-set",
                "style": "paper",
            },
        )
        self.assertEqual(
            [item["kind"] for item in paper["questions"]],
            ["choice"] * 6 + ["written"] * 4,
        )
        self.assertGreater(len({item["topicId"] for item in paper["questions"]}), 1)
        next_request = {"setId": paper["id"], "requestId": "paper-test-next-set"}
        with self.assertRaises(HTTPError) as incomplete:
            self.call("/api/learning/next-practice", self.beta, next_request)
        self.assertEqual(incomplete.exception.code, 400)
        incomplete.exception.close()
        with self.assertRaises(HTTPError) as denied:
            self.call("/api/learning/next-practice", self.alpha, next_request)
        self.assertEqual(denied.exception.code, 403)
        denied.exception.close()
        db = database(self.data / "learning.sqlite3")
        with db() as conn:
            expected_by_id = dict(
                conn.execute(
                    "SELECT id,expected_answer FROM practice_items WHERE set_id=?",
                    (paper["id"],),
                )
            )
        for item in paper["questions"]:
            target = expected_by_id[item["id"]]
            if item["kind"] == "written":
                answer = (
                    ["0", "0"] if item["topicId"] == "decimal" else json.loads(target)
                )
            else:
                answer = (
                    next(option for option in item["options"] if option != target)
                    if item["topicId"] == "decimal"
                    else target
                )
            result = self.call(
                "/api/learning/attempts",
                self.beta,
                {
                    "setId": paper["id"],
                    "questionId": item["id"],
                    "answer": answer,
                },
            )
            self.assertEqual(result["correct"], item["topicId"] != "decimal")
        changed = self.call("/api/learning/next-practice", self.beta, next_request)
        self.assertEqual(changed["sourceSetId"], paper["id"])
        self.assertEqual(changed["topicId"], "decimal")
        self.assertGreater(
            sum(item["topicId"] == "decimal" for item in changed["questions"]), 5
        )
        self.assertEqual(
            self.call("/api/learning/next-practice", self.beta, next_request), changed
        )

    def test_study_stream_citations_persist(self):
        dashboard = self.call("/api/learning/dashboard", self.alpha)
        if not dashboard["books"]:
            self.skipTest("此联调用例需要本地教材样本")
        book = dashboard["books"][0]["id"]
        session = self.call(
            "/api/study/sessions",
            self.alpha,
            {
                "clientId": "textbook-test-client",
                "kind": "book",
                "context": {"bookId": book, "page": 8},
            },
        )
        job = self.call(
            f"/api/study/sessions/{session['id']}/jobs",
            self.alpha,
            {
                "requestId": "textbook-test-question",
                "prompt": "小数加法和减法有什么关系？",
            },
        )
        stream = self.call(
            f"/api/study/jobs/{job['id']}/events", self.alpha, parse=False
        ).decode()
        self.assertIn('"status": "done"', stream)
        restored = self.call(f"/api/study/sessions/{session['id']}", self.alpha)
        refs = restored["messages"][-1]["data"]["references"]
        self.assertEqual({ref["title"] for ref in refs}, {"加法", "减法", "小数"})


class StorageAndToolTests(unittest.TestCase):
    def test_provider_rejects_incomplete_tool_calls(self):
        class Response:
            finish_reason = "length"
            payload = None

            def open(self, request, timeout):
                self.payload = json.loads(request.data)
                return io.BytesIO(
                    json.dumps(
                        {
                            "choices": [
                                {
                                    "finish_reason": self.finish_reason,
                                    "message": {
                                        "tool_calls": [
                                            {
                                                "function": {
                                                    "name": "search_textbook",
                                                    "arguments": '{"terms":["运算律"]}',
                                                }
                                            }
                                        ]
                                    },
                                }
                            ]
                        }
                    ).encode()
                )

        fixture = Response()
        router = ProviderRouter(
            lambda: {
                "AI_BASE_URL": "http://127.0.0.1:18000/v1",
                "AI_API_KEY": "test-key",
                "AI_MODEL": "mock",
            },
            lambda key, default=None: default,
            lambda *_: None,
            fixture,
        )
        question = [{"role": "user", "content": "教材哪里讲运算律？"}]
        self.assertIsNone(router.plan_tool(question, TEXTBOOK_TOOL))
        fixture.finish_reason = "tool_calls"
        self.assertEqual(
            router.plan_tool(question, TEXTBOOK_TOOL)["name"], "search_textbook"
        )
        self.assertFalse(fixture.payload["stream"])

    def test_legacy_schema_loads_and_foreign_keys_are_enforced(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            db = database(path / "learning.db")
            uid = Accounts(db, path).create("previous", "测试", "test-password-only")
            with db() as conn:
                conn.execute(
                    "CREATE TABLE personal_practice_sets(id,user_id,request_id,topic_id,questions,created)"
                )
                conn.execute(
                    "INSERT INTO personal_practice_sets VALUES (?,?,?,?,?,?)",
                    (
                        "legacy",
                        uid,
                        "previous",
                        "addition",
                        '[{"id":"x","stem":"2 + 3","answer":"5"}]',
                        1,
                    ),
                )
                conn.execute(
                    "CREATE TABLE personal_practice_attempts(set_id,question_id,user_id,answer,correct,created)"
                )
                conn.execute(
                    "INSERT INTO personal_practice_attempts VALUES ('legacy','x',?,'5',1,1)",
                    (uid,),
                )
            repo = PracticeRepository(db)
            self.assertEqual(repo.get(uid, "legacy")["attempts"], {"x": True})
            PracticeRepository(db)
            with db() as conn:
                self.assertEqual(
                    conn.execute("PRAGMA foreign_key_check").fetchall(), []
                )
                self.assertEqual(
                    conn.execute("PRAGMA journal_mode").fetchone()[0], "wal"
                )

    def test_generic_tool_parameters_are_scoped(self):
        class Textbook:
            def suggest_terms(self, *_):
                return []

            def search(self, book_id, topics=(), *, terms=()):
                return [{"title": term, "bookId": book_id} for term in terms]

        tools = TeachingTools(Textbook(), None)
        with self.assertRaises(PermissionError):
            tools.call(
                "search_textbook",
                {"terms": ["运算律"], "bookId": "other"},
                book_id="current",
            )
        with self.assertRaises(ValueError):
            tools.call(
                "search_textbook",
                {"terms": ["https://example.invalid"]},
                book_id="current",
            )
        agent = TutorAgent(
            tools,
            lambda *_: {
                "name": "search_textbook",
                "arguments": '{"terms":["运算律","交换律"]}',
            },
        )
        _, sources = agent.sources_for_question(
            "current", "教材哪里讲运算律？", lambda *_: None
        )
        self.assertEqual(
            sources,
            [
                {"title": "运算律", "bookId": "current"},
                {"title": "交换律", "bookId": "current"},
            ],
        )


if __name__ == "__main__":
    unittest.main()
