"""Bounded, resumable generation for verified textbook chapters.

Run in the service's existing EnvironmentFile environment. No deployment, PDF,
source exercises, provider credentials, answers or raw model output is copied by
this tool. The private GeneratedPractice database remains the sole checkpoint.

    python deployment/chapter_batch.py --inventory /private/inventory.json
    python deployment/chapter_batch.py --inventory /private/inventory.json --run

The default is a dry run. --run requires an explicitly approved inventory with
readyForGeneration and TOC verification flags. Runtime discovery alone is only
a directory preview, not approval to generate all OCR-derived chapter labels.
A stop file stops between provider calls/quality
stages; an already running provider request may finish first. A later invocation
continues the same private checkpoint. Each invocation visits the finite plan
once and attempts each chapter at most twice, then exits.
"""

from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
import argparse
import hashlib
import importlib
import json
import os
import re
import secrets
import sys
import threading
import time
import unicodedata


SCHEMA = "banxuepaw-chapter-batch-v1"
ROLES = ("teacher", "student", "lead", "expert")
SUBJECTS = dict(math="数学", chinese="语文", english="英语")
REQUEST = re.compile(r"[A-Za-z0-9_-]{8,100}")


class BatchBusy(RuntimeError):
    pass


class BatchStopped(RuntimeError):
    pass


class ChapterActive(RuntimeError):
    pass


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def normalized(value):
    return re.sub(r"[^\w\u3400-\u9fff]+", "", str(value)).lower()


def source_signature(source, titles):
    # Only a trailing copy marker is removed. A different edition, term,
    # sequence of chapters or substantive book title stays a different source.
    title = unicodedata.normalize("NFKC", str(source.get("title", ""))).strip()
    title = re.sub(r"\s*\(\d+\)\s*$", "", title)
    return canonical(
        [source.get(k) for k in ("grade", "subject", "term", "version")]
        + [normalized(title), titles]
    )


@dataclass
class Variant:
    course: dict
    chapter: dict
    source_id: str
    signature: str
    context_hash: str

    @property
    def identity(self):
        return (self.course["id"], self.chapter["id"], self.source_id)


@dataclass
class Candidate:
    variants: list

    @property
    def key(self):
        first = self.variants[0]
        return hashlib.sha256(
            (first.signature + ":" + normalized(first.chapter["title"])).encode()
        ).hexdigest()[:32]


def _variant(book, chapter, record, expected=None):
    source = record.get("book", {})
    match = chapter.get("match", {})
    targets = match.get("bookIds") or [match.get("bookId")]
    if (
        book.get("mode") != "sync"
        or book.get("archived")
        or book.get("duplicateOf")
        or match.get("status") != "verified"
    ):
        raise ValueError("unverified_chapter")
    if (
        source.get("id") not in targets
        or type(book.get("grade")) is not int
        or book["grade"] not in range(1, 7)
        or type(book.get("term")) is not int
        or book["term"] not in (1, 2)
    ):
        raise ValueError("invalid_textbook_scope")
    if any(
        source.get(k) != book.get(k) for k in ("grade", "subject", "term", "version")
    ):
        raise ValueError("metadata_mismatch")
    if (
        book.get("subject") not in SUBJECTS
        or not isinstance(book.get("version"), str)
        or not book["version"].strip()
    ):
        raise ValueError("unknown_curriculum_metadata")
    if re.search(r"待核对|待校验|未知", str(source.get("version", ""))):
        raise ValueError("unverified_version")
    title = match.get("title") or chapter.get("title")
    if (
        not isinstance(title, str)
        or "\ufffd" in title
        or re.fullmatch(
            r"\s*(?:Unit|Revision|Review|Page\s*\d+|第?\s*\d+\s*页)\s*", title, re.I
        )
    ):
        raise ValueError("incomplete_chapter_title")
    entries = record.get("titles", [])
    titles = [normalized(v.get("title", "")) for v in entries if isinstance(v, dict)]
    target = normalized(title)
    if not target or target not in titles or not str(source.get("title", "")).strip():
        raise ValueError("not_in_real_toc")
    if expected:
        verification = [
            expected[k] for k in ("TOCverified", "tocVerified") if k in expected
        ]
        if (
            not verification
            or any(value is not True for value in verification)
            or expected.get("readyForGeneration") is not True
        ):
            raise ValueError("inventory_not_verified")
        if any(
            k in expected and expected[k] != book.get(k)
            for k in ("grade", "subject", "term", "version")
        ):
            raise ValueError("inventory_metadata_mismatch")
        if expected.get("title") and normalized(expected["title"]) != target:
            raise ValueError("inventory_chapter_mismatch")
    index = titles.index(target)
    # Whitelist short directory facts. No textbook pages, exercises, solutions,
    # arbitrary manifest fields or inventory text enter a provider request.
    nearby = entries[max(0, index - 4) : index + 5]
    authority = dict(
        sourceId=source["id"],
        sourceTitle=str(source["title"])[:200],
        grade=source["grade"],
        term=source["term"],
        sourceKind="当前已整理教材的真实目录短事实；以此版本、册次的实际章节为准",
        tocEntries=[
            dict(title=v["title"])
            for v in nearby
            if isinstance(v, dict) and isinstance(v.get("title"), str)
        ],
    )
    clean = {k: book[k] for k in ("id", "grade", "subject", "term", "version")}
    clean.update(
        subjectLabel=SUBJECTS.get(book["subject"], "其他"),
        authoritativeContext=authority,
    )
    current = dict(id=chapter["id"], title=title)
    context = dict(
        grade=clean["grade"],
        subject=clean["subjectLabel"],
        version=clean["version"],
        term=clean["term"],
        chapter=title,
        authoritativeContext=authority,
    )
    digest = hashlib.sha256(
        json.dumps(context, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()
    return Variant(
        clean, current, source["id"], source_signature(source, titles), digest
    )


def collect_candidates(arena, inventory=None, course_view=None):
    """Revalidate the inventory against runtime data; never trust its counts."""
    view = course_view or arena.public_book
    sources = {
        r.get("book", {}).get("id"): r for r in arena.textbooks() if isinstance(r, dict)
    }
    discovered = []
    for meta in arena.catalog().get("books", []):
        book = view(meta["id"])
        for chapter in book.get("chapters", []):
            match = chapter.get("match", {})
            for source_id in match.get("bookIds") or [match.get("bookId")]:
                if source_id not in sources:
                    continue
                try:
                    discovered.append(_variant(book, chapter, sources[source_id]))
                except (ValueError, KeyError, TypeError):
                    continue
    lookup = {v.identity: v for v in discovered}
    rejected = []
    groups = []
    if inventory is None:
        by_scope = {}
        for item in discovered:
            key = (item.signature, normalized(item.chapter["title"]))
            by_scope.setdefault(key, []).append(item)
        groups = list(by_scope.values())
    else:
        rows = inventory.get("chapters") if isinstance(inventory, dict) else None
        if not isinstance(rows, list):
            raise ValueError("invalid_inventory")
        for row in rows:
            if not isinstance(row, dict):
                rejected.append(dict(code="invalid_inventory_entry"))
                continue
            identity = (
                row.get("courseId"),
                row.get("chapterId"),
                row.get("sourceBookId") or row.get("sourceBookid"),
            )
            first = lookup.get(identity)
            if not first:
                rejected.append(dict(code="unverified_inventory_scope"))
                continue
            try:
                _variant(
                    view(identity[0]),
                    next(
                        c
                        for c in view(identity[0])["chapters"]
                        if c["id"] == identity[1]
                    ),
                    sources[identity[2]],
                    row,
                )
            except (ValueError, KeyError, TypeError, StopIteration):
                rejected.append(dict(code="inventory_metadata_mismatch"))
                continue
            variants = [first]
            for alias in row.get("aliases", []):
                if not isinstance(alias, dict):
                    rejected.append(dict(code="invalid_alias"))
                    continue
                ids = alias.get("sourceBookIds") or [
                    alias.get("sourceBookId") or alias.get("sourceBookid")
                ]
                matches = [
                    v
                    for v in discovered
                    if v.course["id"] == alias.get("courseId")
                    and v.chapter["id"] == alias.get("chapterId")
                    and (v.source_id in ids or ids == [None])
                ]
                if not matches or any(
                    v.signature != first.signature
                    or normalized(v.chapter["title"])
                    != normalized(first.chapter["title"])
                    for v in matches
                ):
                    rejected.append(dict(code="alias_metadata_mismatch"))
                    continue
                variants.extend(matches)
            groups.append(variants)
    merged = {}
    seen = set()
    for variants in groups:
        first = variants[0]
        key = (first.signature, normalized(first.chapter["title"]))
        group = merged.setdefault(key, [])
        for item in variants:
            if item.identity not in seen:
                group.append(item)
                seen.add(item.identity)
    return [Candidate(v) for v in merged.values() if v], rejected


def reviewed_questions(bank, candidate):
    """Count actual private quality evidence, never an inventory's claim."""
    result = {}
    for variant in candidate.variants:
        for q in bank.questions(variant.course["id"], variant.chapter["id"]):
            context = q.get("curriculumContext", {})
            audit = q.get("qualityAudit", [])
            if (
                q.get("generated") is not True
                or q.get("retired")
                or q.get("qualityStatus") != "four-role-reviewed"
                or not isinstance(context, dict)
                or not isinstance(audit, list)
                or len(audit) != 4
                or any(not isinstance(r, dict) for r in audit)
                or [r.get("role") for r in audit] != list(ROLES)
                or any(
                    r.get("passed") is not True
                    or r.get("simulated") is not True
                    or not isinstance(r.get("model"), str)
                    or not r["model"].strip()
                    or any(
                        s in r["model"].lower()
                        for s in ("synthetic", "fixture", "mock", "isolated-test")
                    )
                    or not isinstance(r.get("summary"), str)
                    or not r["summary"].strip()
                    for r in audit
                )
                or q.get("teacherPass") is not True
                or q.get("generationModel") != audit[0]["model"]
                or q.get("verificationModel") != audit[-1]["model"]
                or not isinstance(q.get("solution"), list)
                or len(q["solution"]) < 2
            ):
                continue
            if (
                any(
                    context.get(k) != variant.course.get(k)
                    for k in ("grade", "term", "version")
                )
                or normalized(context.get("chapter"))
                != normalized(variant.chapter["title"])
                or context.get("subject") != variant.course["subjectLabel"]
                or not isinstance(context.get("authoritativeContext"), dict)
                or context["authoritativeContext"].get("sourceId") != variant.source_id
            ):
                continue
            digest = hashlib.sha256(
                json.dumps(context, ensure_ascii=False, sort_keys=True).encode()
            ).hexdigest()
            if q.get("curriculumContextHash") != digest or any(
                r.get("contextHash") != digest for r in audit
            ):
                continue
            if (
                _checkpoint_variant(
                    variant,
                    dict(
                        context_hash=digest,
                        value=json.dumps(dict(context=context), ensure_ascii=False),
                    ),
                )
                is None
            ):
                continue
            if (
                isinstance(q.get("id"), str)
                and isinstance(q.get("stem"), str)
                and q["stem"].strip()
            ):
                result.setdefault(q["id"], q)
    return list(result.values())


def coverage(bank, candidate):
    from backend.learning.generated_practice import GeneratedPractice
    from backend.learning.question_engine import tidy

    questions = reviewed_questions(bank, candidate)
    by_id = {q["id"]: q for q in questions}
    # A chapter is complete only when a whole stored, published set passes G's
    # actual canonical 30-slot plan: all point/level/type combinations and all
    # nine required diagrams. An aggregate of partial sets cannot impersonate it.
    enough = False
    for variant in candidate.variants:
        with bank.db() as conn:
            rows = conn.execute(
                "SELECT context_hash,value FROM generated_sets WHERE course_id=? AND chapter_id=?",
                (variant.course["id"], variant.chapter["id"]),
            ).fetchall()
        for row in rows:
            try:
                if _checkpoint_variant(variant, row) is None:
                    continue
                state = json.loads(row["value"])
                ids = state["published"]
                if (
                    not isinstance(ids, list)
                    or len(ids) != 30
                    or len(set(ids)) != 30
                    or any(not isinstance(qid, str) for qid in ids)
                ):
                    continue
                published = [by_id[qid] for qid in ids]
                if any(
                    q.get("curriculumContextHash") != row["context_hash"]
                    for q in published
                ):
                    continue
                GeneratedPractice.coverage(published, state["blueprint"])
                enough = True
            except (ValueError, TypeError, KeyError):
                continue
    return len({tidy(q["stem"]) for q in questions}), enough


@contextmanager
def single_instance(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise ValueError("invalid_lock_path")
    descriptor = os.open(
        path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600
    )
    stream = os.fdopen(descriptor, "r+b", buffering=0)
    try:
        try:
            if os.name == "nt":
                import msvcrt

                if not path.stat().st_size:
                    stream.write(b"0")
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise BatchBusy("batch_already_running") from None
        yield
    finally:
        # Closing the held descriptor releases the lock. Do not unlink: a new
        # inode would allow two workers to believe they own the same lock.
        stream.close()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise ValueError("invalid_state_path")
    temporary = path.with_name(path.name + "." + secrets.token_hex(6) + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        # Windows may briefly deny replacing an existing file while another
        # handle is closing. Retry this already-complete, fsynced file only;
        # permanent permissions and every other error still fail closed.
        retry_delays = (0.02, 0.05, 0.1)
        for attempt in range(len(retry_delays) + 1):
            try:
                os.replace(temporary, path)
                break
            except PermissionError as error:
                if getattr(error, "winerror", None) not in (
                    5,
                    32,
                    33,
                ) or attempt == len(retry_delays):
                    raise
                time.sleep(retry_delays[attempt])
    finally:
        temporary.unlink(missing_ok=True)


def _checkpoint_variant(variant, row):
    if row["context_hash"] == variant.context_hash:
        return variant
    # Browser jobs may have used a different nearby TOC window or explanatory
    # sourceKind. Reuse those facts only after validating them against this
    # exact source's complete real TOC; never restart a sound private draft just
    # because the batch's default wording differs.
    try:
        from backend.learning.generated_practice import GeneratedPractice
        from backend.learning.arena import toc_label_equal

        context = json.loads(row["value"])["context"]
        expected = dict(
            grade=variant.course["grade"],
            subject=variant.course["subjectLabel"],
            version=variant.course["version"],
            term=variant.course["term"],
            chapter=variant.chapter["title"],
        )
        if (
            not isinstance(context, dict)
            or any(context.get(k) != v for k, v in expected.items() if k != "chapter")
            or not toc_label_equal(context.get("chapter"), variant.chapter["title"])
        ):
            return None
        authority = context["authoritativeContext"]
        real = variant.course["authoritativeContext"]
        if (
            authority.get("sourceId") != variant.source_id
            or authority.get("sourceTitle") != real["sourceTitle"]
        ):
            return None
        course = {**variant.course, "authoritativeContext": authority}
        cleaned = GeneratedPractice._authority(course, variant.chapter)
        actual_titles = json.loads(variant.signature)[-1]
        if cleaned != authority or any(
            not any(
                toc_label_equal(
                    v["title"],
                    actual,
                    allow_omitted_de=not toc_label_equal(
                        actual, variant.chapter["title"]
                    ),
                )
                for actual in actual_titles
            )
            for v in cleaned["tocEntries"]
        ):
            return None
        context = {
            **expected,
            "chapter": context["chapter"],
            "authoritativeContext": cleaned,
        }
        digest = hashlib.sha256(
            json.dumps(context, ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest()
        if digest != row["context_hash"]:
            return None
        return Variant(
            {**variant.course, "authoritativeContext": cleaned},
            {**variant.chapter, "title": context["chapter"]},
            variant.source_id,
            variant.signature,
            digest,
        )
    except (ValueError, TypeError, KeyError, AttributeError):
        return None


def _resume(bank, candidate, previous):
    choices = []
    for variant in candidate.variants:
        with bank.db() as conn:
            rows = conn.execute(
                "SELECT request_id,context_hash,status,updated,value FROM generated_sets WHERE course_id=? AND chapter_id=? AND status IN ('needs-repair','running') ORDER BY updated DESC",
                (variant.course["id"], variant.chapter["id"]),
            ).fetchall()
        for row in rows:
            resumed = _checkpoint_variant(variant, row)
            if resumed and REQUEST.fullmatch(row["request_id"]):
                # A web worker may still own this running request. Never guess
                # its liveness from elapsed time or run over its checkpoint.
                # Our own stable batch requests are protected by the DB-wide
                # batch lock; G also applies its per-request process lock.
                if row["status"] == "running" and not row["request_id"].startswith(
                    "chapter_batch_v1_"
                ):
                    raise ChapterActive("active_quality_job")
                choices.append(
                    (
                        row["request_id"] != previous.get("requestId"),
                        -row["updated"],
                        resumed,
                        row["request_id"],
                    )
                )
    if choices:
        _, _, variant, request = min(choices, key=lambda v: (v[0], v[1], v[3]))
        return variant, request
    first = candidate.variants[0]
    scope = canonical([first.identity, first.context_hash])
    return first, "chapter_batch_v1_" + hashlib.sha256(scope.encode()).hexdigest()[:48]


def database_lock(bank, server=None):
    if server is not None and getattr(server, "PRIVATE", None) is not None:
        return Path(server.PRIVATE).resolve() / ".chapter-batch.lock"
    with bank.db() as conn:
        rows = conn.execute("PRAGMA database_list").fetchall()
    main = next((row[2] for row in rows if row[1] == "main" and row[2]), None)
    if not main:
        raise ValueError("persistent_database_required")
    return Path(main).resolve().parent / ".chapter-batch.lock"


def run_batch(
    *,
    server=None,
    arena=None,
    bank=None,
    reply=None,
    state_path,
    inventory=None,
    run=False,
    attempts_per_chapter=2,
    stop_file=None,
    lock_path=None,
    course_view=None,
    clock=time.time,
):
    """Execute one finite pass; injection is shared by the CLI and unit tests."""
    if type(attempts_per_chapter) is not int or not 1 <= attempts_per_chapter <= 2:
        raise ValueError("invalid_attempt_limit")
    if run and inventory is None:
        raise ValueError("approved_inventory_required")
    if server is not None:
        arena = server.ARENA
        bank = arena.generated
        reply = server.routed_reply
        course_view = server.arena_book_view
    if arena is None or bank is None or run and not callable(reply):
        raise ValueError("missing_runtime")
    path = Path(state_path)
    lock = database_lock(bank, server)
    if lock_path is not None and Path(lock_path).resolve() != lock:
        raise ValueError("database_lock_cannot_be_overridden")
    stop = Path(stop_file) if stop_file else path.with_name("chapter-batch.stop")
    if len({p.absolute() for p in (path, lock, stop)}) != 3:
        raise ValueError("overlapping_control_paths")
    with single_instance(lock):
        previous = {}
        if path.exists():
            if path.is_symlink() or path.stat().st_size > 4 * 1024 * 1024:
                raise ValueError("invalid_state_file")
            old = json.loads(path.read_text(encoding="utf-8"))
            if (
                not isinstance(old, dict)
                or old.get("schema") != SCHEMA
                or not isinstance(old.get("chapters"), dict)
            ):
                raise ValueError("invalid_state_file")
            previous = old["chapters"]
        candidates, rejected = collect_candidates(arena, inventory, course_view)
        state = dict(
            schema=SCHEMA,
            dryRun=not run,
            startedAt=int(clock()),
            updatedAt=int(clock()),
            status="running" if run else "planned",
            rejected=len(rejected),
            chapters={},
            candidateCount=len(candidates),
        )
        state_lock = threading.RLock()

        def save():
            with state_lock:
                state["updatedAt"] = int(clock())
                state["visitedCount"] = len(state["chapters"])
                state["completedCount"] = sum(
                    v["status"] in ("complete", "skipped")
                    for v in state["chapters"].values()
                )
                state["failedCount"] = sum(
                    v["status"] in ("needs-repair", "needs-review")
                    for v in state["chapters"].values()
                )
                state["deferredCount"] = sum(
                    v["status"] == "deferred" for v in state["chapters"].values()
                )
                state["remainingCount"] = len(candidates) - state["completedCount"]
                atomic_json(path, state)

        def stopped():
            return stop.exists()

        def emit(_kind, _value):
            # Raw model tokens and error strings are deliberately ignored.
            if stopped():
                raise BatchStopped("stop_requested")
            if _kind == "status":
                with state_lock:
                    item["lastActivityAt"] = int(clock())
                    save()

        def bounded_reply(*args, **kwargs):
            if stopped():
                raise BatchStopped("stop_requested")
            return reply(*args, **kwargs)

        for candidate in candidates:
            first = candidate.variants[0]
            old = previous.get(candidate.key, {})
            if not isinstance(old, dict):
                old = {}
            count, enough = coverage(bank, candidate)
            item = dict(
                courseId=first.course["id"],
                chapterId=first.chapter["id"],
                sourceBookId=first.source_id,
                title=first.chapter["title"],
                grade=first.course["grade"],
                subject=first.course["subject"],
                term=first.course["term"],
                version=first.course["version"],
                reviewedCount=count,
                missing=max(0, 30 - count),
                coverageComplete=enough,
                status="complete" if enough else "pending",
                attemptsThisRun=0,
                attemptsTotal=old.get("attemptsTotal", 0)
                if type(old.get("attemptsTotal")) is int
                else 0,
            )
            if isinstance(old.get("requestId"), str) and REQUEST.fullmatch(
                old["requestId"]
            ):
                item["requestId"] = old["requestId"]
            state["chapters"][candidate.key] = item
            if enough:
                item["status"] = "skipped"
                save()
                continue
            if stopped():
                state["status"] = "stopped"
                save()
                break
            if not run:
                save()
                continue
            try:
                variant, request = _resume(bank, candidate, old)
            except ChapterActive:
                item.update(status="deferred", errorCode="active_quality_job")
                save()
                continue
            except Exception:
                item.update(status="needs-repair", errorCode="checkpoint_unavailable")
                save()
                continue
            item.update(
                courseId=variant.course["id"],
                chapterId=variant.chapter["id"],
                sourceBookId=variant.source_id,
                requestId=request,
            )
            for _attempt in range(attempts_per_chapter):
                if stopped():
                    state["status"] = "stopped"
                    break
                item.update(
                    status="generating",
                    attemptsThisRun=item["attemptsThisRun"] + 1,
                    attemptsTotal=item["attemptsTotal"] + 1,
                )
                save()
                try:
                    bank.generate(
                        variant.course, variant.chapter, request, bounded_reply, emit
                    )
                    count, enough = coverage(bank, candidate)
                    item.update(
                        reviewedCount=count,
                        missing=max(0, 30 - count),
                        coverageComplete=enough,
                    )
                    if not enough:
                        item.update(
                            status="needs-review",
                            errorCode="published_quality_insufficient",
                        )
                        break
                    item.update(status="complete")
                    item.pop("errorCode", None)
                    break
                except KeyboardInterrupt:
                    item.update(status="paused", errorCode="interrupted")
                    state["status"] = "stopped"
                    break
                except Exception:
                    # Detailed provider errors and rejected answer drafts stay
                    # in the private application checkpoint, not this summary.
                    item.update(
                        status="paused" if stopped() else "needs-repair",
                        errorCode="stop_requested"
                        if stopped()
                        else "generation_failed",
                    )
                    if stopped():
                        state["status"] = "stopped"
                        break
                finally:
                    save()
            if state["status"] == "stopped":
                break
        if state["status"] != "stopped":
            state["status"] = "finished" if run else "planned"
        save()
        return state


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path)
    parser.add_argument("--state", type=Path)
    parser.add_argument("--stop-file", type=Path)
    parser.add_argument("--question-scope", type=Path, help="Classify reviewed questions after generation.")
    parser.add_argument("--attempts-per-chapter", type=int, choices=(1, 2), default=2)
    parser.add_argument(
        "--run",
        action="store_true",
        help="Actually call the configured model provider; otherwise only plan.",
    )
    args = parser.parse_args(argv)
    if args.run and args.inventory is None:
        print(
            canonical(
                dict(status="not-started", errorCode="approved_inventory_required")
            ),
            flush=True,
        )
        return 2
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))
    private = Path(os.environ.get("BANXUEPAW_DATA_DIR", str(root / ".local")))
    try:
        inventory = (
            json.loads(args.inventory.read_text(encoding="utf-8"))
            if args.inventory
            else None
        )
        runtime = importlib.import_module("server")
        intake = None
        if args.run and args.question_scope:
            from deployment.question_catalog import make_intake, read_json

            intake = make_intake(runtime)
            scopes = intake.register(read_json(args.question_scope))
        result = run_batch(
            server=runtime,
            state_path=args.state or private / "chapter-batch-state.json",
            inventory=inventory,
            run=args.run,
            attempts_per_chapter=args.attempts_per_chapter,
            stop_file=args.stop_file,
        )
        summary = {
            k: result[k]
            for k in (
                "schema",
                "dryRun",
                "status",
                "candidateCount",
                "visitedCount",
                "completedCount",
                "failedCount",
                "deferredCount",
                "remainingCount",
                "rejected",
            )
        }
        if intake and result["status"] != "stopped":
            summary["questionClassification"] = intake.classify(scopes)
        print(canonical(summary), flush=True)
        return (
            0
            if not args.run or (
                result["remainingCount"] == 0
                and not result["rejected"]
                and not summary.get("questionClassification", {}).get("unavailable")
            )
            else 2
        )
    except BatchBusy:
        print(
            canonical(dict(status="not-started", errorCode="batch_already_running")),
            flush=True,
        )
        return 3
    except Exception:
        print(
            canonical(dict(status="not-started", errorCode="batch_failed")), flush=True
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
