"""Bounded, source-aware tools for the children's learning flow."""

import hashlib
import json
import os
import re
import threading
import urllib.error
import urllib.request
from pathlib import Path
from collections import OrderedDict
import unicodedata
from urllib.parse import urlsplit


from backend.learning.topics import TOPICS


class TextbookSearch:
    def __init__(self, library, db, material_path, catalog):
        self.library, self.db, self.material_path = library, db, material_path
        self.catalog = catalog
        self._lock = threading.RLock()
        self._cache = OrderedDict()

    def suggest_terms(self, book_id, text):
        """Use verified titles of the selected edition to recognize chapter names."""
        terms = []
        for book in self.catalog():
            if book["book"]["id"] != book_id:
                continue
            for chapter in book.get("titles", []):
                title = re.sub(r"[（(][^）)]*[）)]", "", chapter.get("title", ""))
                title = title.split("—", 1)[-1]
                for term in (title, *re.split(r"与|和", title)):
                    if 2 <= len(term) <= 24 and term in text and term not in terms:
                        terms.append(term)
        return terms[:4]

    def _revision(self, item):
        path = self.material_path(item)
        stat = path.stat()
        with self.db() as conn:
            masks = conn.execute(
                "SELECT key,value FROM kv WHERE key LIKE ? ORDER BY key",
                ("clean:" + item["id"] + ":%",),
            ).fetchall()
        payload = [
            stat.st_mtime_ns,
            stat.st_size,
            [(row["key"], row["value"]) for row in masks],
        ]
        return hashlib.sha256(
            json.dumps(payload, ensure_ascii=False).encode()
        ).hexdigest()

    def _pages(self, book_id):
        item = self.library.get(book_id)
        if item.get("kind") != "textbook":
            raise PermissionError("请选择可以阅读的教材")
        revision = self._revision(item)
        with self._lock:
            cached = self._cache.get(book_id)
            if cached and cached[0] == revision:
                self._cache.move_to_end(book_id)
                return item, cached[1]
            meta = self.library.metadata(book_id)
            if meta["pageCount"] > 500:
                raise ValueError("教材页数较多，请先选择章节")
            pages = []
            for page in range(1, meta["pageCount"] + 1):
                text = self.library.page_text(book_id, page, clean=True)
                cleaned = re.sub(r"\s+", " ", text).strip()[:16000]
                normalized = unicodedata.normalize("NFKC", cleaned)
                pages.append((normalized, re.sub(r"\s+", "", normalized).casefold()))
            self._cache[book_id] = (revision, pages)
            if len(self._cache) > 6:
                self._cache.popitem(last=False)
            return item, pages

    def search(self, book_id, topic_ids=(), *, terms=()):
        if not isinstance(book_id, str) or not re.fullmatch(r"[a-f0-9]{20}", book_id):
            raise ValueError("请先选择教材")
        item, pages = self._pages(book_id)
        references = []
        groups = [(TOPICS[t][0], TOPICS[t][1]) for t in dict.fromkeys(topic_ids)]
        names = {name for name, _ in groups}
        groups.extend(
            (term, (term,)) for term in dict.fromkeys(terms) if term not in names
        )
        for title, keywords in groups[:4]:
            folded = [
                unicodedata.normalize("NFKC", word).casefold().replace(" ", "")
                for word in keywords
            ]
            matches = []
            for page, (text, compact) in enumerate(pages, 1):
                if page <= 6 and (
                    "目录" in compact[:15] or "版权" in compact or "出版社" in compact
                ):
                    continue
                if not text:
                    continue
                matched = [word for word in folded if word in compact]
                if not matched:
                    continue
                word = max(matched, key=len)
                score = sum(min(compact.count(k), 3) * len(k) for k in matched)
                position = compact.find(word)
                if position < 28:
                    score += 5
                pattern = re.compile(r"\s*".join(map(re.escape, word)), re.I)
                occurrence = pattern.search(text)
                offset = occurrence.start() if occurrence else 0
                excerpt = text[max(0, offset - 32) : offset + 100].strip()
                matches.append((score, -page, excerpt))
            if matches:
                _, negative_page, excerpt = max(matches)
                page = -negative_page
                references.append(
                    dict(
                        title=title,
                        bookId=book_id,
                        bookTitle=item["title"],
                        page=page,
                        excerpt=excerpt,
                        url=f"/#/reader/{book_id}/{page}",
                    )
                )
        return references


class TavilySearch:
    DOMAINS = ("smartedu.cn", "moe.gov.cn", "people.com.cn", "kepu.gov.cn")

    def __init__(self, api_key=None, opener=None):
        self.api_key = (
            api_key if api_key is not None else os.environ.get("TAVILY_API_KEY", "")
        )
        self.opener = opener or urllib.request.build_opener()

    def search(self, topic_id):
        if topic_id not in TOPICS:
            raise ValueError("知识点不正确")
        key = self.api_key() if callable(self.api_key) else self.api_key
        if not key:
            return {"available": False, "sources": []}
        body = json.dumps(
            dict(
                query="小学数学 " + TOPICS[topic_id][0] + " 知识讲解",
                search_depth="basic",
                max_results=4,
                safe_search=True,
                include_domains=list(self.DOMAINS),
                include_raw_content=False,
                include_answer=False,
            )
        ).encode()
        request = urllib.request.Request(
            "https://api.tavily.com/search",
            data=body,
            headers={
                "Authorization": "Bearer " + key,
                "Content-Type": "application/json",
            },
        )
        try:
            with self.opener.open(request, timeout=12) as response:
                data = json.loads(response.read(1024 * 1024))
        except (urllib.error.URLError, OSError, ValueError):
            return {"available": False, "sources": []}
        sources = []
        results = data.get("results") if isinstance(data, dict) else None
        for result in results if isinstance(results, list) else []:
            if not isinstance(result, dict):
                continue
            url = result.get("url", "")
            if not isinstance(url, str) or not 1 <= len(url) <= 2048:
                continue
            try:
                parsed = urlsplit(url)
                host = (parsed.hostname or "").lower()
            except ValueError:
                continue
            if (
                parsed.scheme != "https"
                or parsed.username
                or parsed.password
                or not any(host == d or host.endswith("." + d) for d in self.DOMAINS)
            ):
                continue
            title = re.sub(r"\s+", " ", str(result.get("title", "资料")))[:100]
            sources.append(dict(title=title, url=url))
        return {"available": True, "sources": sources[:4]}


TEXTBOOK_TOOL = {
    "type": "function",
    "function": {
        "name": "search_textbook",
        "description": "在已选教材里查找能解释当前问题的知识点。一项只填一个常见知识点名。",
        "parameters": {
            "type": "object",
            "properties": {
                "terms": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "maxItems": 4,
                }
            },
            "required": ["terms"],
            "additionalProperties": False,
        },
    },
}

PUBLIC_TOOL = {
    "type": "function",
    "function": {
        "name": "search_public_sources",
        "description": "为用户明确选择的课题查找公开学习资料。",
        "parameters": {
            "type": "object",
            "properties": {"topicId": {"type": "string", "enum": list(TOPICS)}},
            "required": ["topicId"],
            "additionalProperties": False,
        },
    },
}


class TeachingTools:
    def __init__(self, textbook_search, web_search):
        self.textbook_search, self.web_search = textbook_search, web_search

    def call(self, name, args, *, book_id=None, public_topic=None, reserve=None):
        if not isinstance(args, dict):
            raise ValueError("工具参数不正确")
        if name == "search_textbook" and book_id and set(args) == {"terms"}:
            terms = args["terms"]
            if not isinstance(terms, list) or not 1 <= len(terms) <= 4:
                raise ValueError("教材工具需要 1 至 4 个知识点")
            if any(
                not isinstance(term, str)
                or not re.fullmatch(
                    r"[\u3400-\u9fffA-Za-z][\u3400-\u9fffA-Za-z ]{1,23}", term
                )
                for term in terms
            ):
                raise ValueError("教材工具需要简短的知识点名称")
            return self.textbook_search.search(book_id, terms=terms)
        if (
            name == "search_public_sources"
            and public_topic in TOPICS
            and reserve
            and args == {"topicId": public_topic}
        ):
            reserve()
            return self.web_search.search(public_topic)
        raise PermissionError("此工具不可用")


def child_tutor_rules():
    path = Path(__file__).with_name("skills") / "child-tutor" / "SKILL.md"
    return path.read_text(encoding="utf-8").split("---", 2)[-1].strip()
