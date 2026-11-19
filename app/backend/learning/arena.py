"""Compact, source-traceable Markdown exercises and server-only answer retrieval."""

from pathlib import Path
from functools import lru_cache
import os, json, zipfile, re, threading, hashlib, io, tempfile, base64
from collections import Counter
from PIL import Image, ImageOps
from backend.learning.question_engine import practice_group
from backend.learning.curriculum_catalog import CurriculumCatalog


def normalized(value):
    return re.sub(r"[^\w\u3400-\u9fff]+", "", str(value)).lower()


def toc_label_equal(label, actual, allow_omitted_de=False):
    left, right = normalized(label), normalized(actual)
    if left == right:
        return True
    if not allow_omitted_de or abs(len(left) - len(right)) != 1:
        return False
    longer, shorter = (left, right) if len(left) > len(right) else (right, left)
    return any(
        c == "的" and longer[:i] + longer[i + 1 :] == shorter
        for i, c in enumerate(longer)
    )


class Arena:
    def __init__(self, root):
        self.path = Path(
            os.environ.get("BANXUEPAW_ARENA_DATA", str(Path(root) / "arena-data.bwa"))
        )
        self._lock = threading.RLock()
        self._archive = None
        self._stamp = None
        self._manifest = None
        self.generated = None
        self._virtual = None
        self.curriculum = CurriculumCatalog(
            Path(
                os.environ.get(
                    "BANXUEPAW_CURRICULUM_PROFILES",
                    str(Path(root) / "curriculum-profiles.json"),
                )
            ),
            Path(
                os.environ.get(
                    "BANXUEPAW_CURRICULUM_BANK", str(Path(root) / "curriculum-bank")
                )
            ),
        )
        self._curriculum_links = None

    def _curriculum_has(self, identity):
        try:
            return self.curriculum.has(identity)
        except (ValueError, OSError):
            return False

    def _curriculum_sources(self, identity):
        if not self._curriculum_has(identity) or not self._open():
            return {}
        counts = self.generated.counts() if self.generated else {}
        stamp = (self._stamp, self.curriculum._stamp, tuple(sorted(counts.items())))
        if self._curriculum_links and self._curriculum_links[0] == stamp:
            return self._curriculum_links[1].get(identity, {})
        views = {
            m["id"]: self.curriculum.book(m["id"], questions=False)
            for m in self.curriculum.catalog()["books"]
        }
        result = {
            course: {c["id"]: [] for c in book["chapters"]}
            for course, book in views.items()
        }
        by_source = {}
        for course, book in views.items():
            for source in book["meta"]["textbookIds"]:
                by_source.setdefault(source, set()).add(course)
        for old in self._manifest["books"]:
            if old.get("mode") != "sync":
                continue
            source = self._read_book(old["id"], self._stamp)
            generated = (
                self.generated.questions(old["id"])
                if self.generated and counts.get(old["id"])
                else []
            )
            chapter_counts = Counter(
                q["chapterId"]
                for q in source.get("questions", []) + generated
                if not q.get("retired")
            )
            for chapter in source["chapters"]:
                match = chapter.get("match", {})
                ids = match.get("bookIds") or [match.get("bookId")]
                if match.get("status") != "verified":
                    continue
                candidates = set().union(
                    *(by_source.get(source_id, set()) for source_id in ids)
                )
                for course in candidates:
                    book = views[course]
                    meta = book["meta"]
                    if any(
                        old.get(k) != meta.get(k)
                        for k in ("grade", "term", "subject", "version")
                    ):
                        continue
                    target = next(
                        (
                            c
                            for c in book["chapters"]
                            if c.get("tocVerified")
                            and toc_label_equal(
                                match.get("title") or chapter["title"], c["title"]
                            )
                        ),
                        None,
                    )
                    if target:
                        count = chapter_counts[chapter["id"]]
                        result[course][target["id"]].append(
                            dict(
                                courseId=old["id"],
                                chapterId=chapter["id"],
                                title=old["title"],
                                questionCount=count,
                                sourceStatus="legacy-practice"
                                if count
                                else "legacy-reference",
                                originalPractice=True,
                            )
                        )
        self._curriculum_links = (stamp, result)
        return result.get(identity, {})

    def _open(self):
        if not self.path.is_file():
            return None
        stamp = (self.path.stat().st_mtime_ns, self.path.stat().st_size)
        with self._lock:
            if stamp != self._stamp:
                if self._archive:
                    self._archive.close()
                self._archive = zipfile.ZipFile(self.path)
                info = self._archive.getinfo("manifest.json")
                if info.file_size > 8 * 1024**2:
                    raise ValueError("练习目录过大")
                manifest = json.loads(self._archive.read(info))
                if manifest.get("schema") != "banxuepaw-arena-v1":
                    raise ValueError("练习资料版本不正确")
                manifest["books"] = [
                    book
                    for book in manifest["books"]
                    if book.get("subject") != "science"
                ]
                manifest["textbooks"] = [
                    entry
                    for entry in manifest.get("textbooks", [])
                    if entry.get("book", {}).get("subject") != "science"
                ]
                self._manifest = manifest
                self._stamp = stamp
                self._read_book.cache_clear()
                self._virtual = None
        return self._archive

    def catalog(self, book_id=None):
        opened = self._open()
        try:
            curriculum = self.curriculum.catalog(book_id)
        except (ValueError, OSError):
            curriculum = dict(books=[], ready=False)
        if curriculum.get("ready"):
            for meta in curriculum["books"]:
                sources = self._curriculum_sources(meta["id"])
                entries = list(
                    {
                        (s["courseId"], s["chapterId"]): s
                        for values in sources.values()
                        for s in values
                    }.values()
                )
                meta.update(
                    legacyQuestionCount=sum(s["questionCount"] for s in entries),
                    legacySources=[s for s in entries if s["questionCount"]],
                )
            return dict(
                curriculum,
                summary={
                    **curriculum.get("summary", {}),
                    "catalogKind": "source-verified-textbooks",
                },
            )
        if not opened:
            return dict(books=[], summary={}, ready=False)
        counts = self.generated.counts() if self.generated else {}
        courses = [
            {
                **b,
                "generatedQuestionCount": counts.get(b["id"], 0),
                "questionCount": b.get("questionCount", 0) + counts.get(b["id"], 0),
            }
            for b in self._manifest["books"]
        ]
        courses.extend(
            {
                **b["meta"],
                "generatedQuestionCount": counts.get(identity, 0),
                "questionCount": counts.get(identity, 0),
            }
            for identity, b in self._virtual_books().items()
            if b.get("missingChapters") or counts.get(identity)
        )
        if book_id:
            courses = [b for b in courses if book_id in b.get("textbookIds", [])]
        return dict(books=courses, summary=self._manifest["summary"], ready=True)

    def _virtual_books(self):
        if self._virtual is not None:
            return self._virtual
        with self._lock:
            covered = {}
            result = {}
            for meta in self._manifest["books"]:
                for chapter in self._read_book(meta["id"], self._stamp)["chapters"]:
                    match = chapter.get("match", {})
                    if match.get("status") == "verified":
                        for identity in match.get("bookIds") or [match.get("bookId")]:
                            covered.setdefault(identity, set()).add(
                                normalized(match.get("title") or chapter["title"])
                            )
            for item in self._manifest.get("textbooks", []):
                source = item.get("book", {})
                identity = source.get("id")
                if (
                    not identity
                    or source.get("grade") not in range(1, 7)
                    or source.get("term") not in [1, 2]
                ):
                    continue
                course = hashlib.sha256(
                    ("textbook-ai-course:" + identity).encode()
                ).hexdigest()[:20]
                chapters = []
                seen = set()
                for entry in item.get("titles", []):
                    title = entry.get("title", "").strip()
                    key = normalized(title)
                    if (
                        not key
                        or key in seen
                        or re.fullmatch(r"封面|封底|目录|版权页", title)
                    ):
                        continue
                    seen.add(key)
                    chapters.append(
                        dict(
                            id=hashlib.sha256(key.encode()).hexdigest()[:12],
                            title=title,
                            questionCount=0,
                            unitCount=0,
                            match=dict(
                                status="verified",
                                bookId=identity,
                                bookIds=[identity],
                                title=title,
                                evidence="来自当前版本教材已整理的真实目录",
                                tocPage=entry.get("page"),
                            ),
                        )
                    )
                if not chapters:
                    continue
                meta = dict(
                    id=course,
                    title=source.get("title", "教材") + " · AI章节练习",
                    grade=source["grade"],
                    grades=[source["grade"]],
                    gradeLabel=str(source["grade"]) + "年级",
                    subject=source["subject"],
                    subjectLabel=dict(math="数学", chinese="语文", english="英语").get(
                        source["subject"], "其他"
                    ),
                    version=source["version"],
                    term=source["term"],
                    mode="sync",
                    modeLabel="AI章节练习",
                    textbookIds=[identity],
                    generatedCourse=True,
                    questionCount=0,
                    unitCount=0,
                    answerCount=0,
                    chapterCount=len(chapters),
                    verifiedChapters=len(chapters),
                    markdownPath="",
                )
                result[course] = dict(
                    meta=meta,
                    chapters=chapters,
                    units=[],
                    questions=[],
                    answers=[],
                    missingChapters=any(
                        normalized(c["title"]) not in covered.get(identity, set())
                        for c in chapters
                    ),
                )
            self._virtual = result
            return result

    def _valid_id(self, identity):
        if not isinstance(identity, str) or not re.fullmatch(r"[a-f0-9]{20}", identity):
            raise ValueError("练习资料编号不正确")
        return identity

    @lru_cache(maxsize=8)
    def _read_book(self, identity, stamp):
        with self._lock:
            entry = self._archive.getinfo("books/" + identity + ".json")
            if entry.file_size > 12 * 1024**2:
                raise ValueError("练习内容过大")
            return json.loads(self._archive.read(entry))

    def book(self, identity):
        self._valid_id(identity)
        if self._curriculum_has(identity):
            book = self.curriculum.book(identity)
            sources = self._curriculum_sources(identity)
            for chapter in book["chapters"]:
                chapter["legacySources"] = sources.get(chapter["id"], [])
            book["meta"]["legacyCourseIds"] = list(
                dict.fromkeys(
                    s["courseId"] for values in sources.values() for s in values
                )
            )
            return book
        if not self._open():
            raise ValueError("练习资料尚未导入")
        if not any(b["id"] == identity for b in self._manifest["books"]):
            virtual = self._virtual_books().get(identity)
            if virtual:
                return virtual
            raise ValueError("练习资料不存在")
        return self._read_book(identity, self._stamp)

    def public_book(self, identity):
        book = self.book(identity)
        result = {
            **book["meta"],
            "chapters": json.loads(json.dumps(book["chapters"])),
            "units": [
                {
                    k: u[k]
                    for k in [
                        "id",
                        "chapterId",
                        "title",
                        "sourcePage",
                        "sourceName",
                        "hasAnswer",
                    ]
                }
                for u in book["units"]
            ],
        }
        generated = (
            self.generated.questions(identity)
            if self.generated and not book["meta"].get("curriculumCourse")
            else []
        )
        result["questionCount"] = result.get("questionCount", 0) + len(generated)
        for chapter in result["chapters"]:
            chapter["questionCount"] = chapter.get("questionCount", 0) + sum(
                q["chapterId"] == chapter["id"] for q in generated
            )
        if not result.get("curriculumCourse"):
            try:
                related = [
                    m["id"]
                    for m in self.curriculum.catalog().get("books", [])
                    if set(m.get("textbookIds", []))
                    & set(result.get("textbookIds", []))
                    and any(
                        s["courseId"] == identity
                        for values in self._curriculum_sources(m["id"]).values()
                        for s in values
                    )
                ]
                if related:
                    result.update(
                        canonicalCourseId=related[0], canonicalCourseIds=related
                    )
            except (ValueError, OSError):
                pass
        return result

    def textbooks(self):
        opened = self._open()
        existing = self._manifest.get("textbooks", []) if opened else []
        try:
            additions = self.curriculum.textbooks()
            ids = {r.get("book", {}).get("id") for r in existing}
            return existing + [r for r in additions if r["book"]["id"] not in ids]
        except (ValueError, OSError):
            return existing

    def question(self, identity):
        if not isinstance(identity, str) or not re.fullmatch(
            r"[a-f0-9]{20}:[a-f0-9]{16}:[a-f0-9]{12}", identity
        ):
            raise ValueError("题目编号不正确")
        if self._curriculum_has(identity.split(":")[0]):
            return self.curriculum.question(identity)
        result = next(
            (
                q
                for q in self.book(identity.split(":")[0]).get("questions", [])
                if q["id"] == identity
            ),
            None,
        )
        if not result and self.generated:
            result = self.generated.get(identity)
        if not result:
            raise ValueError("这道题尚未整理，请从章节重新打开")
        return result

    def public_question(self, identity):
        question = self.question(identity)
        allowed = [
            "id",
            "unitId",
            "chapterId",
            "chapterTitle",
            "number",
            "title",
            "stem",
            "options",
            "type",
            "sourcePage",
            "sourceName",
            "answerStatus",
            "supportBox",
            "segmented",
            "retired",
            "replacementIds",
            "retirementReason",
        ]
        result = {k: question[k] for k in allowed if k in question}
        if question.get("generated"):
            result.update(
                generated=True,
                generationBasis=question.get("generationBasis", "four-role-reviewed"),
            )
            result.update(
                {
                    k: question[k]
                    for k in [
                        "difficulty",
                        "knowledgePoint",
                        "knowledgePointTitle",
                        "qualityStatus",
                        "diagramAlt",
                    ]
                    if k in question
                }
            )
            if question.get("diagram"):
                result.update(
                    imageUrl="/api/arena/questions/" + identity + "/image",
                    diagramUrl="/api/arena/questions/" + identity + "/image",
                    imageSize=[600, 380],
                )
        else:
            result["imageUrl"] = "/api/arena/questions/" + identity + "/image"
            box = question["sourceBox"]
            result["imageSize"] = [max(1, box[2] - box[0]), max(1, box[3] - box[1])]
        if question.get("supportBox"):
            box = question["supportBox"]
            result["supportSize"] = [max(1, box[2] - box[0]), max(1, box[3] - box[1])]
        if question.get("continuation"):
            box = question["continuation"]["sourceBox"]
            result["continuationSize"] = [
                max(1, box[2] - box[0]),
                max(1, box[3] - box[1]),
            ]
        if question.get("supportBox"):
            result["supportUrl"] = result["imageUrl"] + "?part=context"
        if question.get("continuation"):
            result["continuationUrl"] = result["imageUrl"] + "?part=continuation"
        result["course"] = self.book(identity.split(":")[0])["meta"]
        result["practiceGroup"] = practice_group(question, result["course"]["subject"])
        chapter = [
            q["id"]
            for q in self.all_questions(identity.split(":")[0])
            if q["chapterId"] == question["chapterId"] and not q.get("retired")
        ]
        result.update(
            chapterPosition=chapter.index(identity) + 1 if identity in chapter else 0,
            chapterTotal=len(chapter),
        )
        return result

    def question_fingerprint(self, identity):
        question = self.question(identity)
        if question.get("generated"):
            return hashlib.sha256(
                json.dumps(question, ensure_ascii=False, sort_keys=True).encode()
            ).hexdigest()
        units = [
            self.unit(value)
            for value in dict.fromkeys(
                [
                    question["unitId"],
                    question.get("supportUnitId", question["unitId"]),
                    question.get("continuation", {}).get("unitId", question["unitId"]),
                ]
            )
        ]
        source = [
            dict(
                region=u.get("sourceRegion"),
                images=[
                    p.get("asset")
                    for p in u["parts"]
                    if p.get("kind") == "exercise-source"
                ],
            )
            for u in units
        ]
        return hashlib.sha256(
            json.dumps(
                dict(question=question, source=source),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()

    def similar_questions(self, identity):
        q = self.question(identity)
        book = self.book(identity.split(":")[0])
        group = practice_group(q, book["meta"]["subject"])
        if not group:
            return dict(group=None, questionIds=[])
        ids = [
            item["id"]
            for item in self.all_questions(identity.split(":")[0])
            if item["id"] != identity
            and item["chapterId"] == q["chapterId"]
            and practice_group(item, book["meta"]["subject"]) == group
        ]
        return dict(group=group, questionIds=ids)

    def chapter_questions(self, identity, chapter):
        book = self.book(identity)
        item = next((c for c in book["chapters"] if c["id"] == chapter), None)
        if not item:
            raise ValueError("章节不存在，请重新选择")
        questions = [
            q
            for q in self.all_questions(identity)
            if q["chapterId"] == chapter and not q.get("retired")
        ]
        return dict(
            book=book["meta"],
            chapter=item,
            questions=[
                {
                    **{
                        k: q[k]
                        for k in [
                            "id",
                            "unitId",
                            "title",
                            "number",
                            "type",
                            "answerStatus",
                            "generated",
                            "difficulty",
                            "knowledgePoint",
                            "knowledgePointTitle",
                            "qualityStatus",
                        ]
                        if k in q
                    },
                    "preview": re.sub(r"\s+", " ", q.get("stem", "")).strip()[:65],
                }
                for q in questions
            ],
        )

    def all_questions(self, identity):
        book = self.book(identity)
        return book.get("questions", []) + (
            self.generated.questions(identity)
            if self.generated and not book["meta"].get("curriculumCourse")
            else []
        )

    def question_image(self, identity, context=False):
        if isinstance(identity, str) and self._curriculum_has(identity.split(":")[0]):
            if context:
                raise ValueError("本题没有额外材料图")
            return self.curriculum.image(identity)
        question = self.question(identity)
        if question.get("generated"):
            from backend.learning.exercise_diagrams import render_diagram

            if context:
                raise ValueError("本题没有额外材料图")
            if question.get("diagramImage"):
                encoded = question["diagramImage"]
                if not isinstance(encoded, str) or len(encoded) > 1024 * 1024:
                    raise ValueError("已审核图示数据不正确")
                data = base64.b64decode(encoded, validate=True)
                if hashlib.sha256(data).hexdigest() != question.get("diagramImageHash"):
                    raise ValueError("图示与审核版本不一致，请联系管理员核对")
                with Image.open(io.BytesIO(data)) as image:
                    if image.format != "PNG" or image.size != (600, 380):
                        raise ValueError("已审核图示尺寸不正确")
                    image.verify()
                return data, "image/png"
            return render_diagram(question.get("diagram")), "image/png"
        unit = self.unit(
            question.get("supportUnitId", question["unitId"])
            if context is True
            else question.get("continuation", {}).get("unitId", question["unitId"])
            if context == "continuation"
            else question["unitId"]
        )
        part = next(
            (p for p in unit["parts"] if p.get("kind") == "exercise-source"), None
        )
        if not part:
            raise ValueError("原题图示尚未准备完成，请重新打开章节")
        raw, _ = self.asset(unit["id"], part["asset"])
        source = unit["sourceRegion"]
        box = (
            question.get("supportBox")
            if context is True
            else question.get("continuation", {}).get("sourceBox")
            if context == "continuation"
            else question["sourceBox"]
        )
        if not box:
            raise ValueError("这道题没有额外阅读材料")
        with Image.open(io.BytesIO(raw)) as image:
            x, y, r, b = source
            scale_x = image.width / max(1, r - x)
            scale_y = image.height / max(1, b - y)
            clip = [
                max(0, int((box[0] - x) * scale_x)),
                max(0, int((box[1] - y) * scale_y)),
                min(image.width, int((box[2] - x) * scale_x + 1)),
                min(image.height, int((box[3] - y) * scale_y + 1)),
            ]
            if clip[2] <= clip[0] or clip[3] <= clip[1]:
                raise ValueError("题图范围不正确")
            crop = image.crop(tuple(clip))
            out = io.BytesIO()
            crop.save(out, "WEBP", quality=92, method=3)
            crop.close()
            return out.getvalue(), "image/webp"

    def unit(self, identity, answers=False):
        if not isinstance(identity, str) or not re.fullmatch(
            r"[a-f0-9]{20}:[a-f0-9]{16}", identity
        ):
            raise ValueError("练习编号不正确")
        book = self.book(identity.split(":")[0])
        collection = book["answers"] if answers else book["units"]
        unit = next((u for u in collection if u["id"] == identity), None)
        if not unit and not answers and self.generated:
            unit = self.generated.unit(identity)
        if not unit:
            raise ValueError("练习内容不存在")
        return unit

    def answer_units(self, identity, chapter=None, page=1):
        if self._curriculum_has(identity):
            from backend.learning.curriculum_answers import reference_page

            return reference_page(self.curriculum, identity, chapter, page)
        book = self.book(identity)
        answers = book["answers"]
        if chapter:
            answers = [a for a in answers if a.get("chapterId") == chapter]
        return dict(book=book["meta"], answers=answers)

    def study_unit(self, identity):
        unit = self.unit(identity)
        if unit.get("generated"):
            return dict(unit, previousUnitId=None, nextUnitId=None)
        units = self.book(identity.split(":")[0])["units"]
        index = next(i for i, u in enumerate(units) if u["id"] == identity)
        result = dict(
            unit,
            previousUnitId=units[index - 1]["id"] if index else None,
            nextUnitId=units[index + 1]["id"] if index + 1 < len(units) else None,
        )
        previous = units[index - 1] if index else None
        if (
            previous
            and unit.get("sourceDocument")
            and previous.get("sourceDocument") == unit["sourceDocument"]
            and previous["sourcePage"] == unit["sourcePage"] - 1
            and previous["chapterId"] == unit["chapterId"]
            and re.match(
                r"^(?:结果|的正确|的答案|接上页|续上页|续表|[，。；）)])",
                unit["text"].lstrip(),
            )
        ):
            result["continuation"] = {
                key: previous[key]
                for key in ["id", "title", "sourcePage", "text", "parts"]
            }
        return result

    def asset(self, identity, name, answer=False):
        unit = self.unit(identity, answer)
        if not re.fullmatch(r"[a-f0-9]{64}\.(webp|avif)", name) or name not in [
            p.get("asset") for p in unit["parts"] if p.get("type") == "image"
        ]:
            raise ValueError("本题没有这张图示")
        with self._lock:
            data = self._archive.read("images/" + name)
        return data, "image/avif" if name.endswith(".avif") else "image/webp"

    def markdown(self, identity):
        if self._curriculum_has(identity):
            return self.curriculum.markdown(identity)
        book = self.book(identity)
        generated = self.generated.questions(identity) if self.generated else []
        if book["meta"].get("generatedCourse") or generated:
            lines = (
                ["# " + book["meta"]["title"], ""]
                if book["meta"].get("generatedCourse")
                else []
            )
            lines += [
                "## AI原创练习与复核参考",
                "",
                "四个角色均为模型模拟，不是出版社或真人审定。",
                "",
            ]
            for chapter in book["chapters"]:
                questions = [q for q in generated if q["chapterId"] == chapter["id"]]
                if not questions and not book["meta"].get("generatedCourse"):
                    continue
                lines += ["### " + chapter["title"], ""]
                if not questions:
                    lines += ["本章尚未生成练习。", ""]
                for i, q in enumerate(questions, 1):
                    lines += [
                        '<a id="q-' + q["id"].replace(":", "-") + '"></a>',
                        "#### " + str(i) + ". " + q["title"],
                        "知识点："
                        + q.get("knowledgePointTitle", q.get("knowledgePoint", "")),
                        q["stem"],
                        *[(o["id"] + ". " + o["text"]) for o in q.get("options", [])],
                        "",
                    ]
                    if q.get("diagram"):
                        lines += [
                            "![题目图示](diagrams/"
                            + q["id"].replace(":", "-")
                            + ".png)",
                            "",
                        ]
                    lines += [
                        "参考答案：" + q["answer"],
                        *[
                            (str(n + 1) + ". " + step)
                            for n, step in enumerate(q.get("solution", []))
                        ],
                        "",
                    ]
            appendix = "\n".join(lines).encode()
            if book["meta"].get("generatedCourse"):
                return appendix, book["meta"]["title"] + ".md"
            with self._lock:
                return self._archive.read(
                    book["meta"]["markdownPath"]
                ) + b"\n\n" + appendix, book["meta"]["title"] + ".md"
        with self._lock:
            return self._archive.read(book["meta"]["markdownPath"]), book["meta"][
                "title"
            ] + ".md"

    def bundle_stream(self, identity):
        if self._curriculum_has(identity):
            book = self.book(identity)
            markdown, name = self.curriculum.markdown(identity)
            out = tempfile.SpooledTemporaryFile(max_size=1024**2, mode="w+b")
            try:
                with zipfile.ZipFile(
                    out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
                ) as target:
                    target.writestr(
                        name, markdown.replace(b"../../images/", b"images/")
                    )
                    seen = set()
                    for q in book["questions"]:
                        sha = q.get("diagramImageHash")
                        if q.get("hasDiagram") and sha not in seen:
                            target.writestr(
                                "images/" + sha + ".png",
                                self.curriculum.image(q["id"])[0],
                            )
                            seen.add(sha)
                out.seek(0)
                return out, book["meta"]["title"] + ".zip"
            except BaseException:
                out.close()
                raise
        book = self.book(identity)
        names = {
            p["asset"]
            for u in book["units"] + book["answers"]
            for p in u["parts"]
            if p.get("type") == "image"
        }
        markdown, _ = self.markdown(identity)
        markdown = markdown.replace(b"../../../images/", b"images/")
        out = tempfile.SpooledTemporaryFile(max_size=1024**2, mode="w+b")
        try:
            with zipfile.ZipFile(
                out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
            ) as target:
                # One course = one Markdown. Large downloads spill to an automatically removed temp file.
                target.writestr(book["meta"]["title"] + ".md", markdown)
                if self.generated:
                    for question in self.generated.questions(identity):
                        if question.get("diagram"):
                            target.writestr(
                                "diagrams/" + question["id"].replace(":", "-") + ".png",
                                self.question_image(question["id"])[0],
                            )
                for name in sorted(names):
                    with self._lock:
                        data = self._archive.read("images/" + name)
                    target.writestr(
                        "images/" + name, data, compress_type=zipfile.ZIP_STORED
                    )
            out.seek(0)
            return out, book["meta"]["title"] + ".zip"
        except BaseException:
            out.close()
            raise

    def reference(self, identity, prompt="", role="child"):
        unit = self.study_unit(identity)
        book = self.book(identity.split(":")[0])
        ids = unit.get("answerIds", [])
        answers = [a for a in book["answers"] if a["id"] in ids]
        context = (
            "练习原题（OCR整理，复杂算式与图示另附；存在疑义时先核对，不得猜）：\n"
            + unit["text"][:10000]
        )
        if unit.get("continuation"):
            context += (
                "\n当前开头接上一页，补充上一页原题条件（只用于理解接续题，不混用题号）：\n"
                + unit["continuation"]["text"][-10000:]
            )
        context += (
            "\n来源："
            + book["meta"]["title"]
            + "，文件第"
            + str(unit["sourcePage"])
            + "页；章节："
            + unit["chapterTitle"]
        )
        exact = unit.get("answerMatchLevel") == "exact-question" and len(answers) == 1
        if answers and (role in ["parent", "admin"] or exact):
            context += "\n仅供服务端核对的参考资料，不是给学生展示的答案：\n"
            for answer in answers[:4]:
                context += (
                    "【"
                    + answer["sourceName"]
                    + "，文件第"
                    + str(answer["sourcePage"])
                    + "页】\n"
                    + answer["text"][:3500]
                    + "\n"
                )
            context += "以上来源经过章节/标题或印刷页码匹配。仍须核对具体题号、数值与条件；不一致时不能作为本题答案。"
        elif answers:
            methods = [
                "平均分",
                "乘法",
                "除法",
                "单位",
                "面积",
                "周长",
                "约分",
                "通分",
                "小数",
                "混合运算",
                "线段图",
                "等量关系",
                "方程",
                "余数",
                "比例",
                "百分数",
                "统计",
                "联系上下文",
                "主旨",
                "时态",
                "主语",
                "单复数",
            ]
            source = "\n".join(a["text"] for a in answers)
            found = [word for word in methods if word in source]
            context += (
                "\n已检索到同章参考资料，但未完成当前题号的一一匹配；仅提供方法线索："
                + ("、".join(found) if found else unit["chapterTitle"])
                + "。不得把同章其他题的数值或选项当成本题答案，先根据原题推导。"
            )
        else:
            context += "\n这段原题没有通过匹配校验的参考答案。可以分步推导，但不得宣称有出版社标准答案。"
        if prompt:
            context += "\n学生当前提问：" + prompt[:3000]
        return context

    def tutor_image(self, identity):
        unit = self.study_unit(identity)
        groups = []
        if unit.get("continuation"):
            groups.append(
                [
                    dict(p, unitId=unit["continuation"]["id"])
                    for p in unit["continuation"]["parts"]
                    if p.get("type") == "image"
                ]
            )
        groups.append(
            [
                dict(p, unitId=identity)
                for p in unit["parts"]
                if p.get("type") == "image"
            ]
        )
        parts = []
        offset = 0
        for group in groups:
            if group and all(len(p.get("sourceBox", [])) == 4 for p in group):
                left = min(p["sourceBox"][0] for p in group)
                top = min(p["sourceBox"][1] for p in group)
                height = max(p["sourceBox"][3] for p in group) - top
                for part in group:
                    x, y, r, b = part["sourceBox"]
                    part["sourceBox"] = [
                        x - left,
                        y - top + offset,
                        r - left,
                        b - top + offset,
                    ]
                offset += height + 24
            parts.extend(group)
        if not parts:
            return None
        positioned = all(len(p.get("sourceBox", [])) == 4 for p in parts)
        if positioned:
            width = max(int(p["sourceBox"][2]) for p in parts) + 12
            height = max(int(p["sourceBox"][3]) for p in parts) + 12
            scale = min(1, 2200 / max(1, width), 3000 / max(1, height))
            size = (max(1, round(width * scale)), max(1, round(height * scale)))
        else:
            width = max(p.get("width", 1) for p in parts)
            height = sum(p.get("height", 1) + 20 for p in parts)
            scale = min(1, 2200 / max(1, width), 3000 / max(1, height))
            size = (max(1, round(width * scale)), max(1, round(height * scale)))
        canvas = Image.new("RGB", size, "white")
        y = 0
        try:
            # Include every necessary crop in its source position: small diagrams must not be dropped.
            for part in parts:
                data, mime = self.asset(part["unitId"], part["asset"])
                with Image.open(io.BytesIO(data)) as raw:
                    image = ImageOps.exif_transpose(raw).convert("RGB")
                    box = (
                        part["sourceBox"]
                        if positioned
                        else [0, y, image.width, y + image.height]
                    )
                    target = (
                        max(1, round((box[2] - box[0]) * scale)),
                        max(1, round((box[3] - box[1]) * scale)),
                    )
                    resized = image.resize(target, Image.Resampling.LANCZOS)
                    canvas.paste(
                        resized, (round(box[0] * scale), round(box[1] * scale))
                    )
                    resized.close()
                    image.close()
                    y += part.get("height", 1) + 20
            out = io.BytesIO()
            canvas.save(out, "JPEG", quality=92)
            return out.getvalue()
        finally:
            canvas.close()
