"""Parent-only reference pagination; HTTP callers must enforce family access."""

from backend.learning.answer_reference import check_reference


def reference_page(catalog, course, chapter=None, page=1, size=20):
    if type(size) is not int or not 1 <= size <= 30:
        raise ValueError("参考答案每页数量不正确")
    try:
        page = int(page)
    except (TypeError, ValueError):
        raise ValueError("参考答案页码不正确") from None
    book = catalog.book(course, questions=False)
    chapters = book["chapters"]
    if chapter:
        chapters = [c for c in chapters if c["id"] == chapter]
        if not chapters:
            raise ValueError("教材章节不存在")
    available = [c for c in chapters if c["preparationStatus"] == "complete"]
    total = sum(c["questionCount"] for c in available)
    pages = max(1, (total + size - 1) // size)
    page = min(pages, max(1, page))
    start = (page - 1) * size
    end = start + size
    offset = 0
    answers = []
    for section in available:
        count = section["questionCount"]
        if offset < end and offset + count > start:
            questions = catalog.chapter_data(course, section["id"], private=True)[
                "questions"
            ]
            for index in range(max(0, start - offset), min(count, end - offset)):
                q = questions[index]
                check_reference(q)
                answer = q["answer"]
                choice = next(
                    (o["text"] for o in q.get("options", []) if o["id"] == answer), None
                )
                visible_answer = answer + (" · " + choice if choice is not None else "")
                text = (
                    "### 题目\n"
                    + q["stem"]
                    + "\n"
                    + "".join(
                        "\n" + o["id"] + ". " + o["text"] for o in q.get("options", [])
                    )
                    + "\n\n### 配套答案\n"
                    + visible_answer
                    + "\n\n### 详细解答\n"
                    + "\n".join(
                        str(n + 1) + ". " + step for n, step in enumerate(q["solution"])
                    )
                )
                answers.append(
                    dict(
                        id=q["id"],
                        questionId=q["id"],
                        chapterId=section["id"],
                        title="第" + str(index + 1) + "题 · " + q["stem"][:70],
                        sourceName=section["title"] + " · 本机预置原创题",
                        sourcePage=0,
                        generated=True,
                        hasCorrectReference=True,
                        parts=[dict(type="text", text=text)],
                        **(
                            dict(
                                diagramUrl="/api/arena/questions/" + q["id"] + "/image"
                            )
                            if q.get("diagram")
                            else {}
                        ),
                    )
                )
        offset += count
    return dict(
        book=book["meta"],
        answers=answers,
        total=total,
        page=page,
        pages=pages,
        pageSize=size,
        generated=True,
        complete=bool(chapters) and len(chapters) == len(available),
        pendingChapters=len(chapters) - len(available),
    )
