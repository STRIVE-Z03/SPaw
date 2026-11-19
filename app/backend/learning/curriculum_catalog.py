"""Source-bound textbook directory and locally compiled exercise bank overlay."""

from pathlib import Path
from functools import lru_cache
import copy, hashlib, io, json, re
from PIL import Image
from backend.learning.generated_practice import GeneratedPractice

PROFILE_SCHEMA = "banxuepaw-curriculum-profiles-v1"
BANK_SCHEMA = "banxuepaw-curriculum-bank-v1"
SUBJECTS = {"math": "数学", "english": "英语", "chinese": "语文"}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def _sha(value):
    return isinstance(value, str) and bool(re.fullmatch("[a-f0-9]{64}", value))


def _id(value):
    return isinstance(value, str) and bool(re.fullmatch("[a-f0-9]{20}", value))


def source_identity(book, source_id=None):
    """A primary source is stable before alias visual comparisons complete."""
    source = source_id or book.get("sourceBookId") or book.get("id")
    if (
        not _id(source)
        or not _sha(book.get("contentDigest"))
        or not _sha(book.get("physicalSha256"))
    ):
        raise ValueError("教材来源身份尚未核对完整")
    if _sha(book.get("visualDigest")) and _sha(book.get("sourceIdentityDigest")):
        if (
            hashlib.sha256(
                (book["contentDigest"] + book["visualDigest"]).encode()
            ).hexdigest()
            != book["sourceIdentityDigest"]
        ):
            raise ValueError("教材联合来源身份无效")
        return book["sourceIdentityDigest"]
    return digest(
        dict(
            sourceBookId=source,
            contentDigest=book["contentDigest"],
            physicalSha256=book["physicalSha256"],
        )
    )


def course_id(book, source_id=None):
    source = source_id or book.get("sourceBookId") or book.get("id")
    return hashlib.sha256(
        ("curriculum-source:" + source + ":" + source_identity(book, source)).encode()
    ).hexdigest()[:20]


class CurriculumCatalog:
    def __init__(self, path, bank_dir=None):
        self.path = Path(path)
        self.bank_dir = (
            Path(bank_dir) if bank_dir else self.path.parent / "curriculum-bank"
        )
        self._stamp = None
        self._records = {}
        self._summary = {}

    def _load(self):
        if not self.path.is_file():
            return False
        stat = self.path.stat()
        stamp = (stat.st_mtime_ns, stat.st_size)
        if stamp == self._stamp:
            return True
        if stat.st_size > 30 * 1024**2:
            raise ValueError("教材课程索引过大")
        document = json.loads(self.path.read_text(encoding="utf-8"))
        if (
            not isinstance(document, dict)
            or document.get("schema") != PROFILE_SCHEMA
            or not isinstance(document.get("textbooks"), list)
        ):
            raise ValueError("教材课程索引版本不正确")
        records = {}
        unverified_aliases = 0
        for book in document["textbooks"]:
            if not isinstance(book, dict):
                raise ValueError("教材来源条目不完整")
            if book.get("subject") not in SUBJECTS:
                continue
            source = book.get("sourceBookId", book.get("id"))
            identity = source_identity(book)
            course = course_id(book)
            if course in records:
                raise ValueError("教材来源身份重复")
            sources = [source]
            aliases = [
                s for s in book.get("sourceBookIds", []) if s != source and _id(s)
            ]
            # Text equality alone never proves that geometry/illustrations are
            # the same. Only independently compared visual sequences may merge.
            proofs = book.get("aliasEvidence", [])
            if _sha(book.get("visualDigest")):
                for alias in aliases:
                    proof = next(
                        (
                            p
                            for p in proofs
                            if isinstance(p, dict)
                            and (p.get("sourceBookId") or p.get("id")) == alias
                        ),
                        {},
                    )
                    if (
                        proof.get("textDigest", proof.get("contentDigest"))
                        == book["contentDigest"]
                        and proof.get("visualDigest") == book["visualDigest"]
                        and proof.get("sourceIdentityDigest") == identity
                    ):
                        sources.append(alias)
            unverified_aliases += len(set(aliases) - set(sources))
            chapters = []
            profiles = {}
            seen = set()
            for raw in book.get("chapters", []):
                if (
                    not isinstance(raw, dict)
                    or not isinstance(raw.get("chapterId"), str)
                    or not re.fullmatch("[A-Za-z0-9_-]{1,100}", raw["chapterId"])
                    or raw["chapterId"] in seen
                ):
                    raise ValueError("教材实际章节编号重复或无效")
                seen.add(raw["chapterId"])
                ready = (
                    book.get("identityVerified") is True
                    and raw.get("tocVerified") is True
                    and raw.get("scopeVerified") is True
                )
                reasons = list(raw.get("pendingReasons", []))
                target = 0
                point_count = len(raw.get("knowledgePoints", []))
                if book.get("identityVerified") is not True:
                    reasons.append("教材版本身份尚待核对")
                if ready:
                    try:
                        if (
                            raw.get("sourceBookId") != source
                            or raw.get("sourceContentDigest") != book["contentDigest"]
                            or any(
                                raw.get(k) != book.get(k)
                                for k in ("grade", "term", "subject", "version")
                            )
                        ):
                            raise ValueError("正文资料与教材版本不一致")
                        clean = GeneratedPractice._profile(raw)
                        plan = GeneratedPractice._profile_blueprint(raw)
                        target = plan["targetCount"]
                        point_count = len(clean["knowledgePoints"])
                    except (ValueError, TypeError, KeyError):
                        ready = False
                        reasons.append(
                            "正文知识点、词汇语法或练习范围尚未通过本地合同核对"
                        )
                profiles[raw["chapterId"]] = copy.deepcopy(raw)
                chapters.append(
                    dict(
                        id=raw["chapterId"],
                        title=raw.get("title", "待核对章节"),
                        questionCount=0,
                        unitCount=0,
                        scopeVerified=ready,
                        tocVerified=raw.get("tocVerified") is True,
                        preparationStatus="ready-to-compile"
                        if ready
                        else "pending-review",
                        pendingReasons=reasons,
                        targetQuestionCount=target,
                        knowledgePointCount=point_count,
                        sourceStartPage=raw.get("startPage"),
                        sourceEndPage=raw.get("endPage"),
                        match=dict(
                            status="verified" if ready else "pending",
                            bookId=source,
                            bookIds=sources,
                            title=raw.get("title", ""),
                            evidence="当前实物目录与正文知识点核对"
                            if ready
                            else "本章正文范围待核对",
                        ),
                    )
                )
            meta = dict(
                id=course,
                title=book.get("title", "教材"),
                grade=book["grade"],
                grades=[book["grade"]],
                gradeLabel=str(book["grade"]) + "年级",
                subject=book["subject"],
                subjectLabel=SUBJECTS.get(book["subject"], book["subject"]),
                version=book["version"],
                term=book["term"],
                mode="sync",
                modeLabel="教材同步练习",
                textbookIds=sources,
                sourceBookId=source,
                sourceIdentityDigest=identity,
                sourceContentDigest=book["contentDigest"],
                identityVerified=book.get("identityVerified") is True,
                curriculumCourse=True,
                generatedCourse=True,
                questionCount=0,
                unitCount=0,
                answerCount=0,
                chapterCount=len(chapters),
                verifiedChapters=sum(c["scopeVerified"] for c in chapters),
                completedChapters=0,
                markdownPath="books/" + course + ".md",
                legacyCourseIds=[],
            )
            meta["tocPreview"] = [c["title"] for c in chapters if c["tocVerified"]][:3]
            records[course] = dict(
                meta=meta,
                chapters=chapters,
                profiles=profiles,
                source=copy.deepcopy(book),
            )
        other_count = 0
        for book in document.get("otherTextbooks", []):
            if book.get("subject") not in SUBJECTS:
                continue
            source = book.get("sourceBookId", book.get("id"))
            if not _id(source):
                continue
            course = hashlib.sha256(
                ("curriculum-pending-source:" + source).encode()
            ).hexdigest()[:20]
            meta = dict(
                id=course,
                title=book.get("title", "待核对教材"),
                grade=book.get("grade"),
                grades=[book.get("grade")],
                gradeLabel=str(book.get("grade", "")) + "年级",
                subject=book.get("subject"),
                subjectLabel=SUBJECTS.get(book.get("subject"), "其他"),
                version=book.get("version", "待核对版本"),
                term=book.get("term"),
                mode="sync",
                modeLabel="教材同步练习",
                textbookIds=[source],
                sourceBookId=source,
                identityVerified=False,
                curriculumCourse=True,
                generatedCourse=True,
                preparationStatus="pending-review",
                pendingReasons=book.get("pendingReasons")
                or ["本册目录及正文范围尚待核对"],
                questionCount=0,
                unitCount=0,
                answerCount=0,
                chapterCount=0,
                verifiedChapters=0,
                completedChapters=0,
                markdownPath="",
                legacyCourseIds=[],
            )
            records[course] = dict(
                meta=meta, chapters=[], profiles={}, source=copy.deepcopy(book)
            )
            other_count += 1
        revisions = {}
        for record in records.values():
            meta = record["meta"]
            key = tuple(meta.get(k) for k in ("grade", "subject", "term", "version"))
            revisions[key] = revisions.get(key, 0) + 1
        for record in records.values():
            meta = record["meta"]
            meta["hasAlternateRevision"] = (
                revisions[
                    tuple(meta.get(k) for k in ("grade", "subject", "term", "version"))
                ]
                > 1
            )
            if meta["hasAlternateRevision"]:
                meta["matchingTip"] = (
                    "同年级有不同正文修订资料，请对照孩子课本的章节目录选择。"
                )
        self._records = records
        self._summary = dict(
            textbooks=len(records),
            mathEnglishTextbooks=len(records) - other_count,
            otherPendingTextbooks=other_count,
            chapters=sum(len(b["chapters"]) for b in records.values()),
            verifiedScopes=sum(
                c["scopeVerified"] for b in records.values() for c in b["chapters"]
            ),
            unverifiedSourceAliases=unverified_aliases,
        )
        self._stamp = stamp
        self._read_file.cache_clear()
        return True

    def _compiled(self):
        path = self.bank_dir / "public" / "catalog.json"
        if not path.is_file():
            return dict(schema=BANK_SCHEMA, books={})
        data = self._read_file(str(path), path.stat().st_mtime_ns, path.stat().st_size)
        if data.get("schema") != BANK_SCHEMA or not isinstance(data.get("books"), dict):
            raise ValueError("预置练习索引格式不正确")
        return data

    @staticmethod
    @lru_cache(maxsize=12)
    def _read_file(path, stamp, size):
        if size > 30 * 1024**2:
            raise ValueError("预置练习文件过大")
        return json.loads(Path(path).read_text(encoding="utf-8"))

    def has(self, identity):
        return bool(self._load() and identity in self._records)

    def catalog(self, book_id=None):
        if not self._load():
            return dict(books=[], summary={}, ready=False)
        books = [
            self.book(identity, questions=False)["meta"] for identity in self._records
        ]
        if book_id:
            books = [b for b in books if book_id in b["textbookIds"]]
        return dict(books=books, summary=self._summary, ready=True)

    def textbooks(self):
        if not self._load():
            return []
        result = []
        for record in self._records.values():
            meta = record["meta"]
            for source in meta["textbookIds"]:
                result.append(
                    dict(
                        book=dict(
                            id=source,
                            title=meta["title"],
                            grade=meta["grade"],
                            subject=meta["subject"],
                            term=meta["term"],
                            version=meta["version"],
                        ),
                        titles=[
                            dict(title=c["title"], page=c.get("sourceStartPage"))
                            for c in record["chapters"]
                            if c["tocVerified"]
                        ],
                    )
                )
        return result

    def book(self, identity, questions=True):
        if not self.has(identity):
            raise ValueError("教材同步课程不存在")
        record = self._records[identity]
        meta = copy.deepcopy(record["meta"])
        chapters = copy.deepcopy(record["chapters"])
        manifest = self._compiled().get("books", {}).get(identity, {})
        compiled = manifest.get("chapters", {})
        items = []
        units = []
        for chapter in chapters:
            value = compiled.get(chapter["id"], {})
            if value.get("complete") is True:
                chapter.update(
                    questionCount=value["questionCount"],
                    unitCount=1,
                    preparationStatus="complete",
                    targetQuestionCount=value["targetCount"],
                    unitIds=[value["unitId"]],
                )
                meta["completedChapters"] += 1
                if questions:
                    data = self.chapter_data(identity, chapter["id"])
                    items.extend(data["questions"])
                    units.append(
                        dict(
                            id=value["unitId"],
                            chapterId=chapter["id"],
                            chapterTitle=chapter["title"],
                            title=chapter["title"],
                            text="\n".join(q["stem"] for q in data["questions"]),
                            sourcePage=0,
                            sourceName="本机预置原创同步练习",
                            hasAnswer=False,
                            generated=True,
                            parts=[],
                            questionIds=[q["id"] for q in data["questions"]],
                        )
                    )
            meta["questionCount"] += chapter["questionCount"]
            meta["unitCount"] += chapter["unitCount"]
        return dict(
            meta=meta, chapters=chapters, units=units, questions=items, answers=[]
        )

    def chapter_data(self, course, chapter, private=False):
        if not self.has(course) or chapter not in self._records[course]["profiles"]:
            raise ValueError("预置章节不存在")
        expected = (
            self._compiled()
            .get("books", {})
            .get(course, {})
            .get("chapters", {})
            .get(chapter, {})
        )
        filename = expected.get(
            "privateFile" if private else "publicFile", chapter + ".json"
        )
        if not isinstance(filename, str) or not re.fullmatch(
            re.escape(chapter) + r"(?:-[a-f0-9]{24})?\.json", filename
        ):
            raise ValueError("预置章节文件编号无效")
        path = (
            self.bank_dir
            / ("private" if private else "public")
            / "chapters"
            / course
            / filename
        )
        if not path.is_file():
            raise ValueError("本章题目正在本机准备，请先选择已完成章节")
        stat = path.stat()
        data = self._read_file(str(path), stat.st_mtime_ns, stat.st_size)
        key = "privateSha256" if private else "publicSha256"
        if not expected.get("complete") or hashlib.sha256(
            path.read_bytes()
        ).hexdigest() != expected.get(key):
            raise ValueError("预置章节数据与发布索引不一致")
        return copy.deepcopy(data)

    def compile_inputs(self, course, chapter, target=None):
        if not self.has(course):
            raise ValueError("教材同步课程不存在")
        record = self._records[course]
        raw = record["profiles"].get(chapter)
        entry = next((c for c in record["chapters"] if c["id"] == chapter), None)
        if not raw or not entry or not entry["scopeVerified"]:
            raise ValueError("本章正文范围尚待核对，不允许生成完整题组")
        plan = GeneratedPractice._profile_blueprint(raw, target)
        meta = record["meta"]
        authority = dict(
            sourceId=meta["sourceBookId"],
            sourceTitle=meta["title"],
            grade=meta["grade"],
            term=meta["term"],
            sourceKind="本机实际教材目录与正文核对；页码为保留阅读页",
            tocEntries=[
                dict(
                    title=c["title"],
                    **(
                        dict(page=c["sourceStartPage"])
                        if type(c.get("sourceStartPage")) == int
                        else {}
                    ),
                )
                for c in record["chapters"]
                if c["tocVerified"]
            ],
        )
        course_value = {
            k: meta[k]
            for k in ("id", "grade", "subject", "subjectLabel", "version", "term")
        }
        course_value.update(
            authoritativeContext=authority,
            requireCurriculumProfile=True,
            chapterQuestionTarget=plan["targetCount"],
        )
        return (
            course_value,
            dict(id=chapter, title=raw["title"], curriculumProfile=copy.deepcopy(raw)),
            plan,
        )

    def question(self, identity):
        parts = identity.split(":") if isinstance(identity, str) else []
        if len(parts) != 3 or not self.has(parts[0]):
            raise ValueError("预置题目不存在")
        course = parts[0]
        unit = ":".join(parts[:2])
        book = self.book(course, questions=False)
        chapter = next(
            (c for c in book["chapters"] if unit in c.get("unitIds", [])), None
        )
        if not chapter:
            raise ValueError("这道题尚未完成本机准备")
        private = self.chapter_data(course, chapter["id"], private=True)
        q = next((q for q in private["questions"] if q["id"] == identity), None)
        if not q:
            raise ValueError("预置题目不存在")
        q["curriculumContext"] = private["contexts"][q["curriculumContextHash"]]
        return q

    def image(self, identity):
        question = self.question(identity)
        sha = question.get("diagramImageHash")
        if not question.get("diagram") or not _sha(sha):
            raise ValueError("本题没有图示")
        path = self.bank_dir / "images" / (sha + ".png")
        data = path.read_bytes()
        if len(data) > 1024**2 or hashlib.sha256(data).hexdigest() != sha:
            raise ValueError("题图与实际审核版本不一致")
        with Image.open(io.BytesIO(data)) as im:
            if im.size != (600, 380) or im.format != "PNG":
                raise ValueError("题图尺寸不正确")
            im.verify()
        return data, "image/png"

    def markdown(self, identity):
        if not self.has(identity):
            raise ValueError("教材同步课程不存在")
        path = self.bank_dir / "public" / "books" / (identity + ".md")
        if not path.is_file():
            raise ValueError("本册同步题目正在本机准备")
        return path.read_bytes(), self._records[identity]["meta"]["title"] + ".md"
