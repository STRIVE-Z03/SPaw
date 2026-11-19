"""HTTP contracts for personal learning, independent of the server handler."""

import re


class LearningRoutes:
    def __init__(self, accounts, service, library):
        self.accounts, self.service, self.library = accounts, service, library

    def _owner(self, actor, child=None):
        owner = self.accounts.learning_owner(actor, child)
        if owner["role"] != "child" or (
            child is not None and str(child) != str(owner["id"])
        ):
            raise PermissionError("请选择自己的学习账号或已绑定的宝宝账号")
        return owner["id"]

    def practice_image(self, actor, match, query):
        uid = self._owner(actor, query.get("childId", [None])[0])
        set_id, item_id, index = match.groups()
        details = self.service.repository.item(uid, set_id, item_id)["details"]
        images = details.get("images", [])
        index = int(index)
        if index >= len(images):
            raise ValueError("这道题没有这张图")
        kind = images[index].partition("?part=")[2]
        return self.service.bank.arena.question_image(
            details["originId"],
            True
            if kind == "context"
            else "continuation"
            if kind == "continuation"
            else False,
        )

    def get(self, actor, path, query):
        def first(key):
            return query.get(key, [None])[0]

        uid = self._owner(actor, first("childId"))
        if path == "/api/learning/dashboard":
            books = [
                {
                    key: book[key]
                    for key in ("id", "title", "subject", "grade", "term", "version")
                }
                for book in self.library.public()
                if book["kind"] == "textbook" and not book.get("error")
            ]
            return {**self.service.dashboard(uid), "books": books}, 200
        if path == "/api/learning/records":
            offset = first("offset") or "0"
            if not offset.isascii() or not offset.isdigit() or len(offset) > 7:
                raise ValueError("记录页编号不正确")
            return self.service.records(uid, int(offset), first("point")), 200
        if path == "/api/learning/lesson":
            return self.service.lesson(first("topicId"), first("bookId")), 200
        match = re.fullmatch(r"/api/learning/practice/([a-f0-9]{32})", path)
        if match:
            return self.service.get_set(uid, match[1]), 200
        return {"error": "接口不存在"}, 404

    def post(self, actor, path, body):
        uid = self._owner(actor, body.get("childId"))
        if path == "/api/learning/practice":
            return self.service.create_set(
                uid,
                body.get("topicId"),
                body.get("requestId"),
                body.get("style"),
                body.get("grade"),
            ), 200
        if path == "/api/learning/next-practice":
            return self.service.next_set(
                uid, body.get("setId"), body.get("requestId")
            ), 200
        if path == "/api/learning/attempts":
            return self.service.submit(
                uid,
                body.get("setId"),
                body.get("questionId"),
                body.get("answer"),
                body.get("elapsed"),
            ), 200
        if path == "/api/learning/sources":
            return self.service.public_sources(uid, body.get("topicId")), 200
        return {"error": "接口不存在"}, 404
