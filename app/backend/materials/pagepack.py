"""Bounded, authenticated-reader storage for page images and original text."""

from pathlib import Path
from functools import lru_cache
import json, zipfile, re, io, os, threading, secrets, html, base64
from PIL import Image
import pypdfium2 as pdfium

EXPORT_LOCK = threading.Lock()


def asset_path(root, name):
    if not isinstance(name, str) or not re.fullmatch(
        r"[a-f0-9]{64}\.(avif|webp)", name
    ):
        raise ValueError("教材页面标识不正确")
    base = (Path(root) / ".page-assets").resolve()
    path = (base / name[:2] / name).resolve()
    if not path.is_relative_to(base) or not path.is_file():
        raise ValueError("教材页面文件缺失")
    return path


@lru_cache(maxsize=4)
def _read(path, stamp, size):
    with zipfile.ZipFile(path) as archive:
        entry = archive.getinfo("manifest.json")
        if entry.file_size > 12 * 1024**2:
            raise ValueError("教材索引过大")
        manifest = json.loads(archive.read(entry))
    if (
        manifest.get("schema") != "banxuepaw-pages-v1"
        or not isinstance(manifest.get("pages"), list)
        or not 0 < len(manifest["pages"]) <= 2000
    ):
        raise ValueError("教材索引格式不正确")
    for page in manifest["pages"]:
        if not isinstance(page, dict) or not re.fullmatch(
            r"[a-f0-9]{64}\.(avif|webp)", page.get("asset", "")
        ):
            raise ValueError("教材页面索引不正确")
        if not isinstance(page.get("text"), str) or len(page["text"]) > 50000:
            raise ValueError("教材文字索引不正确")
        if len(page.get("points", [])) != 2 or any(
            not isinstance(n, (int, float)) or not 1 <= n <= 3000
            for n in page["points"]
        ):
            raise ValueError("教材页面尺寸不正确")
    return manifest


def read(path):
    path = Path(path)
    stat = path.stat()
    return _read(str(path), stat.st_mtime_ns, stat.st_size)


def metadata(path):
    manifest = read(path)
    return dict(
        pageCount=len(manifest["pages"]),
        pages=[
            dict(entry=p["asset"], format="packed", index=i)
            for i, p in enumerate(manifest["pages"])
        ],
        toc=manifest.get("toc", []),
    )


def page_text(path, index):
    return read(path)["pages"][index]["text"][:16000]


def export_html(path, materials, cache, title):
    """A self-contained reading file: no scripts, external assets or network access."""
    cache = Path(cache)
    cache.mkdir(exist_ok=True)
    target = cache / ("offline-" + secrets.token_hex(12) + ".html")
    manifest = read(path)
    try:
        with target.open("wb") as file:

            def write(value):
                file.write(value.encode("utf-8"))

            write(
                '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\';img-src data:;style-src \'unsafe-inline\'"><title>'
                + html.escape(title)
                + "</title><style>body{margin:0;background:#f7f5ef;color:#283d43;font:16px/1.7 system-ui,sans-serif}main{max-width:960px;margin:auto;padding:16px}h1{font-size:22px}h2{font-size:15px}section{background:white;padding:12px;margin:16px 0;border-radius:10px}img{display:block;width:100%;height:auto}nav{display:flex;gap:10px;flex-wrap:wrap}a{color:#25745e}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}summary{cursor:pointer}small{color:#7c8c87}</style><main><h1>"
                + html.escape(title)
                + "</h1><p><small>伴学爪 · 离线阅读版 · 共 "
                + str(len(manifest["pages"]))
                + " 页</small></p><details><summary>目录与页码</summary><nav>"
            )
            toc = manifest.get("toc") or [
                dict(page=i + 1, title="第 " + str(i + 1) + " 页")
                for i in range(len(manifest["pages"]))
            ]
            for item in toc:
                write(
                    '<a href="#page-'
                    + str(int(item["page"]))
                    + '">'
                    + html.escape(item["title"])
                    + "</a>"
                )
            write("</nav></details>")
            for i, record in enumerate(manifest["pages"], 1):
                raw = asset_path(materials, record["asset"]).read_bytes()
                mime = "avif" if record["asset"].endswith(".avif") else "webp"
                write(
                    '<section id="page-'
                    + str(i)
                    + '"><h2>第 '
                    + str(i)
                    + ' 页</h2><img loading="lazy" alt="教材第 '
                    + str(i)
                    + ' 页" src="data:image/'
                    + mime
                    + ";base64,"
                )
                file.write(base64.b64encode(raw))
                write('">')
                if record["text"].strip():
                    write(
                        "<details><summary>查看本页文字</summary><pre>"
                        + html.escape(record["text"])
                        + "</pre></details>"
                    )
                write("</section>")
            write("</main></html>")
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return target


def export_pdf(path, materials, cache, pdf_lock, reuse=True):
    """Create a viewable PDF only when downloaded; cache is bounded separately."""
    path = Path(path)
    cache = Path(cache)
    cache.mkdir(exist_ok=True)
    target = cache / (
        "export-"
        + path.stem
        + "-"
        + str(path.stat().st_mtime_ns)
        + ("" if reuse else "-" + secrets.token_hex(6))
        + ".pdf"
    )
    with EXPORT_LOCK:
        if target.exists():
            target.touch()
            return target
        pending = target.with_suffix(".pending")
        manifest = read(path)
        try:
            with pdf_lock, pdfium.PdfDocument.new() as doc:
                for record in manifest["pages"]:
                    with Image.open(asset_path(materials, record["asset"])) as picture:
                        buffer = io.BytesIO()
                        picture.convert("RGB").save(
                            buffer, "JPEG", quality=90, optimize=True
                        )
                    w, h = record["points"]
                    page = doc.new_page(w, h)
                    image = pdfium.PdfImage.new(doc)
                    image.load_jpeg(io.BytesIO(buffer.getvalue()), inline=True)
                    image.set_matrix(pdfium.PdfMatrix(w, 0, 0, h, 0, 0))
                    page.insert_obj(image)
                    page.gen_content()
                    page.close()
                doc.save(pending)
            os.replace(pending, target)
        finally:
            pending.unlink(missing_ok=True)
        files = sorted(
            (p for p in cache.glob("export-*.pdf") if p != target),
            key=lambda p: p.stat().st_mtime,
        )
        total = sum(p.stat().st_size for p in files) + target.stat().st_size
        for old in files:
            if total <= 64 * 1024**2:
                break
            try:
                size = old.stat().st_size
                old.unlink(missing_ok=True)
                total -= size
            except OSError:
                pass
    return target
