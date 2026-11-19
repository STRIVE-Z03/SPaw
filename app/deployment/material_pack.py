"""Turn local source documents into searchable reading packs."""

import argparse
import hashlib
import io
import json
import re
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

import pypdfium2
from PIL import Image
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Image as PDFImage,
)
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
)

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

from backend.learning.arena import Arena
from backend.learning.arena_practice import load_reviews
from backend.learning.question_engine import regions


def json_file(path, value):
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def selected_pages(spec, count):
    match = re.fullmatch(r"([0-9]+)(?:-([0-9]+))?", spec or f"1-{count}")
    if not match:
        raise ValueError("页码示例为 9 或 9-12")
    first = int(match[1])
    last = int(match[2] or match[1])
    if not 1 <= first <= last <= count:
        raise ValueError(f"所选页码超出文件的 {count} 页")
    return range(first, last + 1)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def clean_text(text):
    return re.sub(r"[\x00-\x09\x0b-\x1f\x7f]", "", text.replace("\r\n", "\n"))


def read_scan(image, ocr_file, url):
    image.thumbnail((2200, 3000))
    image.save(ocr_file, "PNG")
    if url:
        request = urllib.request.Request(
            url, ocr_file.read_bytes(), {"Content-Type": "application/octet-stream"}
        )
        with urllib.request.urlopen(request, timeout=45) as response:
            data = json.load(response)
        return data.get("lines", []), clean_text(data.get("text", ""))
    if sys.platform != "darwin":
        raise ValueError("请用 --ocr-url 连接本地 OCR 服务")
    result = subprocess.run(
        ["swift", str(APP / "deployment/recognize-page.swift"), str(ocr_file)],
        capture_output=True,
        timeout=90,
        check=True,
    )
    lines = json.loads(result.stdout)
    lines.sort(key=lambda line: (line["box"][1], line["box"][0]))
    return lines, "\n".join(line["text"] for line in lines)


def save_image(root, images, image):
    relative = f"images/{len(images) + 1:04}.jpg"
    image.convert("RGB").save(root / relative, quality=89, optimize=True)
    images.append(relative)
    return relative


def page_records(root, source, pages, questions, force_ocr, ocr_url, section, subject):
    records, images = [], []
    scan_file = root / ".scan.png"

    def record_page(page_no, image, embedded):
        mode = "PDF 文字层"
        lines, text = [], clean_text(embedded).strip()
        if force_ocr or questions or not re.search(r"[\w\u4e00-\u9fff]{2}", text):
            mode = "扫描识别"
            lines, text = read_scan(image, scan_file, ocr_url)
        page_image = save_image(root, images, image)
        if questions and lines:
            unit_id = digest(f"{source.name}:{page_no}".encode())[:16]
            unit = dict(
                id=unit_id,
                chapterId=section,
                chapterTitle=section,
                sourcePage=page_no,
                sourceName=source.name,
            )
            clipped = regions(unit, lines, (0, 0, *image.size), subject)
            segmented = [question for question in clipped if question.get("segmented")]
            if segmented:
                for question in segmented:
                    boxes = list(
                        dict.fromkeys(
                            tuple(box)
                            for box in (
                                question.get("supportBox"),
                                question["sourceBox"],
                            )
                            if box
                        )
                    )
                    crops = [save_image(root, images, image.crop(box)) for box in boxes]
                    records.append(
                        {
                            "id": question["id"],
                            "section": section,
                            "page": page_no,
                            "title": question["title"],
                            "stem": question["stem"],
                            "options": question["options"],
                            "images": crops,
                            "pageImage": page_image,
                            "review": "待核对",
                            "recognition": mode,
                        }
                    )
                return
        records.append(
            {
                "id": f"page-{page_no}",
                "section": section,
                "page": page_no,
                "title": f"文件第 {page_no} 页",
                "stem": text,
                "options": [],
                "images": [page_image],
                "pageImage": page_image,
                "review": "待核对",
                "recognition": mode,
            }
        )

    if source.suffix.lower() != ".pdf":
        if pages and pages != "1":
            raise ValueError("单张图片的文件页码为 1")
        with Image.open(source) as image:
            record_page(1, image.convert("RGB"), "")
    else:
        with pypdfium2.PdfDocument(source) as doc:
            for number in selected_pages(pages, len(doc)):
                page = doc[number - 1]
                text = page.get_textpage()
                try:
                    scale = min(2.5, 3000 / max(page.get_size()))
                    bitmap = page.render(scale=scale)
                    try:
                        record_page(
                            number,
                            bitmap.to_pil().convert("RGB"),
                            text.get_text_bounded(),
                        )
                    finally:
                        bitmap.close()
                finally:
                    text.close()
                    page.close()
    scan_file.unlink(missing_ok=True)
    return records


def arena_records(root, arena, identity, pages):
    book = arena.book(identity)
    metadata = book["meta"]
    accepted = load_reviews()
    images = []
    records = []
    source_pages = selected_pages(pages, metadata["sourcePages"]) if pages else None
    for q in sorted(book["questions"], key=lambda question: question["sourcePage"]):
        if q.get("retired") or source_pages and q["sourcePage"] not in source_pages:
            continue
        raw = clean_text(q.get("stem", "")).strip()
        compact = " ".join(raw.split())
        if not raw or (
            len(compact) <= 18 and re.match(r"^(?:答?案见|\d*\s*强化练习)", compact)
        ):
            continue
        ref = accepted.get(q["id"], {})
        checked = ref.get("sourceHash") == arena.question_fingerprint(q["id"])
        # Keep every question image even when OCR omitted its diagram or damaged a symbol.
        parts = [False]
        if q.get("supportBox"):
            parts.insert(0, True)
        if q.get("continuation"):
            parts.insert(0, "continuation")
        pictures = []
        for part in parts:
            data, _ = arena.question_image(q["id"], part)
            with Image.open(io.BytesIO(data)) as image:
                pictures.append(save_image(root, images, image))
        options = q["options"]
        if checked and ref.get("options"):
            options = [
                dict(option, text=text) for option, text in zip(options, ref["options"])
            ]
        records.append(
            {
                "id": q["id"],
                "section": q["chapterTitle"],
                "topic": ref.get("title", "") if checked else "",
                "page": q["sourcePage"],
                "title": q["title"],
                "stem": ref["stem"] if checked else raw,
                "options": options,
                "images": pictures,
                "review": "已核对" if checked else "待核对",
                "recognition": "竞技场原题",
            }
        )
    return metadata["title"], records


def grouped(records):
    sections = {}
    for record in records:
        sections.setdefault(record["section"], []).append(record)
    return sections


def markdown(title, source, records):
    lines = [
        f"# {title}",
        "",
        f"来源 · {source}",
        "",
        "文件页码从 1 起算。待核对内容请对照原图。",
        "",
    ]
    for section, rows in grouped(records).items():
        lines.extend([f"## {section}", ""])
        for row in rows:
            lines.extend(
                [
                    f"### {row['title']}",
                    "",
                    f"{row['recognition']} · 文件页 {row['page']} · {row['review']}",
                    f"题目或页面编号 · `{row['id']}`",
                    "",
                    *[
                        f"> {line}"
                        for line in (row["stem"] or "本页保留原图。").splitlines()
                    ],
                    *[
                        f"> {option['id']}. {option['text']}"
                        for option in row["options"]
                    ],
                    "",
                    *[f"![原题或原页图]({path})" for path in row["images"]],
                    "",
                ]
            )
            if row.get("pageImage") not in (*row["images"], None):
                lines.extend([f"[查看扫描原页]({row['pageImage']})", ""])
    return "\n".join(lines)


def make_pdf(path, title, source, records, page_layout, font_path):
    font_name = "PawReadingText"
    pdfmetrics.registerFont(TTFont(font_name, str(font_path)))
    body = ParagraphStyle(
        "body",
        fontName=font_name,
        fontSize=11,
        leading=16,
        wordWrap="CJK",
        textColor=colors.HexColor("#18374c"),
    )
    cover = ParagraphStyle(
        "title", parent=body, fontSize=20, leading=24, spaceAfter=4 * mm
    )
    heading = ParagraphStyle(
        "heading",
        parent=body,
        fontSize=14,
        leading=19,
        textColor=colors.HexColor("#185282"),
        spaceBefore=3 * mm,
    )
    label = ParagraphStyle(
        "label",
        parent=body,
        fontSize=9,
        leading=13,
        textColor=colors.HexColor("#4c697a"),
    )
    normal_text = lambda value: escape(str(value)).replace("\n", "<br/>")
    story = [
        Paragraph(normal_text(title), cover),
        Paragraph(normal_text(f"来源 · {source}"), label),
        Paragraph("文件页码从 1 起算。待核对内容请对照原图。", label),
        Spacer(1, 3 * mm),
    ]
    for section, rows in grouped(records).items():
        if not page_layout:
            story.append(Paragraph(normal_text(section), heading))
        for index, row in enumerate(rows):
            if page_layout and index:
                story.append(PageBreak())
            number = row["page"]
            block = [
                Paragraph(normal_text(row["title"]), heading if page_layout else body),
                Paragraph(
                    normal_text(
                        f"文件页 {number} · {row['review']} · {row['recognition']}"
                    ),
                    label,
                ),
            ]
            if not page_layout:
                stem = " ".join(row["stem"].splitlines()).strip() or "请看原图。"
                block.append(Paragraph(normal_text(stem), body))
                for option in row["options"]:
                    block.append(
                        Paragraph(
                            normal_text(f"{option['id']}. {option['text']}"), body
                        )
                    )
            figures = [
                PDFImage(str(path.parent / relative), lazy=1)
                for relative in row["images"]
            ]
            if (
                not page_layout
                and len(figures) == 1
                and figures[0].imageWidth <= figures[0].imageHeight * 1.45
                and len(row["stem"]) < 750
            ):
                img = figures[0]
                img._restrictSize(51 * mm, 59 * mm)
                story.append(
                    KeepTogether(
                        [
                            Table(
                                [[block, img]],
                                colWidths=[121 * mm, 55 * mm],
                                style=[
                                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                    ("LEFTPADDING", (0, 0), (0, 0), 0),
                                    ("TOPPADDING", (0, 0), (-1, -1), 0),
                                ],
                            )
                        ]
                    )
                )
                story.append(Spacer(1, 4 * mm))
                continue
            for img in figures:
                img._restrictSize(173 * mm, (118 if page_layout else 55) * mm)
                img.hAlign = "LEFT"
                block.append(img)
            if page_layout:
                story.extend(block)
                if row["stem"]:
                    story.extend(
                        [
                            Spacer(1, 3 * mm),
                            Paragraph("识别文字", label),
                            Paragraph(normal_text(row["stem"]), body),
                        ]
                    )
            else:
                story.append(KeepTogether(block) if len(block) <= 9 else block[0])
                if len(block) > 9:
                    story.extend(block[1:])
            story.append(Spacer(1, 3 * mm))

    def footer(canvas, doc):
        canvas.setFont(font_name, 9)
        canvas.setFillColor(colors.HexColor("#4c697a"))
        canvas.drawRightString(A4[0] - 16 * mm, 11 * mm, f"伴学爪   {doc.page}")

    SimpleDocTemplate(
        str(path),
        pagesize=A4,
        title=title,
        author="伴学爪",
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=15 * mm,
        bottomMargin=18 * mm,
    ).build(
        story,
        onFirstPage=footer,
        onLaterPages=footer,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path, help="本地教材 PDF 或扫描图片")
    source.add_argument("--arena-course", help="竞技场原题归档课程编号")
    parser.add_argument("--pages", help="文件页码，例如 9-12")
    parser.add_argument("--questions", action="store_true", help="按可识别的题号切题")
    parser.add_argument(
        "--force-ocr", action="store_true", help="用原图识别，忽略 PDF 文字层"
    )
    parser.add_argument("--ocr-url", help="可选的 OCR 服务地址")
    parser.add_argument("--section", default="教材练习")
    parser.add_argument(
        "--subject", choices=("math", "chinese", "english"), default="math"
    )
    parser.add_argument(
        "--font",
        type=Path,
        default=Path("/System/Library/Fonts/STHeiti Light.ttc"),
        help="包含中文的 TrueType 字体，用于嵌入 PDF",
    )
    parser.add_argument("--out", type=Path, default=Path("output/pdf"))
    args = parser.parse_args()
    if not args.font.is_file():
        parser.error("请用 --font 选择包含中文的 TrueType 字体")
    args.out.mkdir(parents=True, exist_ok=True)
    if args.input and (
        not args.input.is_file()
        or args.input.suffix.lower()
        not in {".pdf", ".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}
    ):
        parser.error("请选择 PDF、JPG、PNG、WEBP 或 TIFF 文件")
    arena = Arena(APP) if args.arena_course else None
    if arena and not arena.path.is_file():
        parser.error("找不到竞技场归档")
    source_path = args.input or arena.path
    with source_path.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    review_hash = (
        digest(json.dumps(load_reviews(), sort_keys=True).encode()) if arena else ""
    )
    with args.font.open("rb") as stream:
        font_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    settings = [
        checksum,
        source_path.name,
        args.arena_course,
        args.pages,
        args.questions,
        args.force_ocr,
        bool(args.ocr_url),
        args.section,
        args.subject,
        review_hash,
        font_hash,
        3,
    ]
    identity = digest(json.dumps(settings, ensure_ascii=False).encode())[:16]
    destination = args.out / identity
    if destination.is_dir():
        print(destination.resolve())
        return
    with tempfile.TemporaryDirectory(prefix=".pack-", dir=args.out) as staging:
        root = Path(staging)
        (root / "images").mkdir()
        if arena:
            source_label, records = arena_records(
                root, arena, args.arena_course, args.pages
            )
            kind, page_layout = "竞技场题目", False
        else:
            source_label = args.input.name
            kind, page_layout = (
                ("扫描题目", False) if args.questions else ("教材页", True)
            )
            records = page_records(
                root,
                args.input,
                args.pages,
                args.questions,
                args.force_ocr,
                args.ocr_url,
                args.section,
                args.subject,
            )
        if not records:
            parser.error("所选范围内没有可整理的内容")
        title = Path(source_label).stem
        metadata = {
            "id": identity,
            "title": title,
            "source": source_label,
            "sourceSha256": checksum,
            "kind": kind,
            "count": len(records),
            "reviewed": sum(row["review"] == "已核对" for row in records),
            "items": records,
        }
        json_file(root / "index.json", metadata)
        (root / "reader.md").write_text(
            markdown(title, source_label, records), encoding="utf-8"
        )
        make_pdf(
            root / "reader.pdf", title, source_label, records, page_layout, args.font
        )
        with zipfile.ZipFile(
            root / "markdown.zip", "w", zipfile.ZIP_DEFLATED
        ) as bundle:
            for path in [
                root / "reader.md",
                root / "index.json",
                *sorted((root / "images").iterdir()),
            ]:
                bundle.write(path, path.relative_to(root))
        try:
            root.rename(destination)
        except OSError:
            if not (destination / "index.json").is_file():
                raise
    print(destination.resolve())


if __name__ == "__main__":
    main()
