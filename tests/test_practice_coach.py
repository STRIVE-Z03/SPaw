import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from backend.agent.practice_coach import (
    practice_work,
    render_model_reply,
    request_messages,
)
from backend.agent.tutor import TutorAgent
from backend.learning.practice_questions import written


class PracticeCoachTests(unittest.TestCase):
    def setUp(self):
        stem, expected, details = written("decimal", 4, 2)
        self.question = dict(
            stem=stem,
            expected_answer=expected,
            details=details,
            answer=None,
            topic_id="decimal",
        )

    def test_hint_uses_snapshot_without_sending_reference_answer(self):
        work = practice_work(
            {"answers": [" 6 ", "6"], "scratch": " 我把个数写成了米。 "}
        )
        messages = request_messages(self.question, work, "应该怎么换？", "", 4)
        payload = json.loads(messages[1]["content"])
        self.assertEqual(
            payload["work"], {"answers": ["6", "6"], "scratch": "我把个数写成了米。"}
        )
        self.assertNotIn("gradedSteps", payload)
        self.assertNotIn("expectedAnswer", payload)
        self.assertEqual(
            render_model_reply('{"hint":"先把个数换成米。"}', self.question),
            "先把个数换成米。",
        )
        for reply in (
            '{"hint":"等于 0.6 米。"}',
            '{"hint":"答案是零点六。"}',
            '{"hint":"请先选 B。"}',
            '{"hint":"先换单位。","answer":"零点六"}',
            '{"hint"',
            "[]",
        ):
            with self.subTest(reply=reply):
                self.assertIsNone(render_model_reply(reply, self.question))

    def test_step_review_binds_results_to_server_grading(self):
        item = {**self.question, "answer": '["6", "6"]'}
        result = json.dumps(
            {
                "steps": [
                    {"step": 1, "note": "数对了这些小段。"},
                    {"step": 2, "note": "检查这一小步的单位，先把个数换回米。"},
                ]
            }
        )
        rendered = render_model_reply(result, item)
        self.assertIn("第 1 步 · 答对了", rendered)
        self.assertIn("第 2 步 · 你填了 6，参考答案是 0.6", rendered)
        self.assertIsNone(
            render_model_reply(result.replace('"step": 2', '"step": 1'), item)
        )
        self.assertIsNone(
            render_model_reply('{"steps":[{"step":1,"note":"数对了。"}]}', item)
        )

    def test_failed_provider_uses_reviewed_hint_and_keeps_references(self):
        class Textbook:
            def search(self, *_):
                return [{"title": "小数", "page": 37}]

        tools = type("Tools", (), {"textbook_search": Textbook()})()
        events = []
        reply = TutorAgent(tools, None).practice_reply(
            self.question,
            "book",
            "我卡住了",
            lambda kind, values: events.append((kind, values)),
            lambda refs: None,
        )
        self.assertEqual(reply["analysis"]["supportMode"], "local")
        self.assertEqual(reply["analysis"]["references"][0]["page"], 37)
        self.assertNotIn("0.6", reply["reply"])
        self.assertEqual(events[0][0], "delta")

    def test_work_rejects_other_fields_and_oversize_values(self):
        for payload in (
            {"userId": 2},
            {"scratch": "字" * 601},
            {"answers": [123]},
            {"answers": ["1", "2", "3"]},
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    practice_work(payload)
