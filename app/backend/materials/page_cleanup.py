"""Non-destructive promotion detection and reviewable image masks."""

import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import csv
import shutil
import tempfile
import time
from PIL import Image, ImageDraw


def mask_image(data, regions):
    with Image.open(io.BytesIO(data)) as source:
        image = source.convert("RGB")
        draw = ImageDraw.Draw(image)
        for region in regions:
            x, y, w, h = [region[k] for k in ["x", "y", "w", "h"]]
            draw.rectangle(
                (
                    int(x * image.width),
                    int(y * image.height),
                    int((x + w) * image.width),
                    int((y + h) * image.height),
                ),
                fill="white",
            )
        output = io.BytesIO()
        image.save(output, "JPEG", quality=94)
    return output.getvalue()


def analyze(data, private, root):
    import cv2
    import numpy as np

    key = hashlib.sha256(data).hexdigest()
    cached = private / ("cleanup-" + key + ".json")
    try:
        saved = json.loads(cached.read_text(encoding="utf-8"))
        if (
            isinstance(saved, dict)
            and isinstance(saved.get("regions"), list)
            and all(key in saved for key in ("notice", "width", "height"))
        ):
            return saved
    except (OSError, UnicodeError, json.JSONDecodeError):
        # A missing or interrupted cache is rebuilt from the original page.
        pass
    raw = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if raw is None:
        raise ValueError("本页图片无法解析")
    height, width = raw.shape[:2]
    detector = cv2.QRCodeDetector()
    regions = []
    decoded, points = [], None
    try:
        ok, decoded, points, _ = detector.detectAndDecodeMulti(raw)
        if not ok:
            points = None
    except cv2.error:
        pass
    if points is None:
        try:
            ok, points = detector.detectMulti(raw)
            if not ok:
                points = None
        except cv2.error:
            pass
    if points is not None:
        for index, polygon in enumerate(points):
            x1, y1 = np.min(polygon, axis=0)
            x2, y2 = np.max(polygon, axis=0)
            pad = max(6, (x2 - x1) * 0.12)
            x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
            x2, y2 = min(width, x2 + pad), min(height, y2 + pad)
            target = decoded[index] if index < len(decoded) else ""
            official = bool(
                re.search(r"(?:pep\.com\.cn|smartedu\.cn|heep\.cn)", target, re.I)
            )
            regions.append(
                dict(
                    x=float(x1 / width),
                    y=float(y1 / height),
                    w=float((x2 - x1) / width),
                    h=float((y2 - y1) / height),
                    label="教材配套码，建议保留" if official else "二维码，待核对用途",
                    selected=False,
                    source="qr",
                    target=target[:300],
                )
            )
    notice = ""
    try:
        with tempfile.NamedTemporaryFile(
            dir=private, prefix="ocr-", suffix=".jpg", delete=False
        ) as temporary:
            ocr_file = Path(temporary.name)
            temporary.write(data)
        if os.name == "nt":
            executable = str(
                Path(os.environ.get("WINDIR", "C:/Windows"))
                / "System32/WindowsPowerShell/v1.0/powershell.exe"
            )
            result = subprocess.run(
                [
                    executable,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(root / "ocr-windows.ps1"),
                    "-ImagePath",
                    str(ocr_file),
                ],
                capture_output=True,
                timeout=30,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if result.returncode:
                raise ValueError("OCR unavailable")
            ocr = json.loads(result.stdout.decode("utf-8-sig"))
        else:
            executable = shutil.which("tesseract")
            if not executable:
                raise ValueError("OCR unavailable")
            result = subprocess.run(
                [executable, str(ocr_file), "stdout", "-l", "chi_sim+eng", "tsv"],
                capture_output=True,
                timeout=30,
            )
            if result.returncode:
                raise ValueError("OCR unavailable")
            lines = {}
            for word in csv.DictReader(
                io.StringIO(result.stdout.decode("utf-8")), delimiter="\t"
            ):
                if not word.get("text", "").strip() or word.get("level") != "5":
                    continue
                key_line = tuple(
                    word.get(k) for k in ["block_num", "par_num", "line_num"]
                )
                line = lines.setdefault(key_line, dict(text="", words=[]))
                line["text"] += word["text"]
                line["words"].append(
                    dict(
                        text=word["text"],
                        x=int(word["left"]),
                        y=int(word["top"]),
                        width=int(word["width"]),
                        height=int(word["height"]),
                    )
                )
            ocr = dict(lines=list(lines.values()))
        keywords = [
            "扫码关注",
            "关注公众号",
            "微信公众号",
            "扫码领取",
            "免费资料",
            "领取资料",
            "小程序",
            "添加微信",
            "进群",
            "领取答案",
            "扫码下载",
        ]
        for line in ocr.get("lines", []):
            text = re.sub(r"\s+", "", line.get("text", ""))
            if not any(keyword in text for keyword in keywords):
                continue
            words = line.get("words", [])
            if not words:
                continue
            x1 = max(0, min(w["x"] for w in words) - 8)
            y1 = max(0, min(w["y"] for w in words) - 8)
            x2 = min(width, max(w["x"] + w["width"] for w in words) + 8)
            y2 = min(height, max(w["y"] + w["height"] for w in words) + 8)
            regions.append(
                dict(
                    x=x1 / width,
                    y=y1 / height,
                    w=(x2 - x1) / width,
                    h=(y2 - y1) / height,
                    label="推广文字：" + text[:60],
                    selected=True,
                    source="ocr",
                )
            )
        for region in regions:
            if region["source"] == "qr" and any(
                r["source"] == "ocr"
                and abs((r["y"] + r["h"] / 2) - (region["y"] + region["h"] / 2)) < 0.15
                for r in regions
            ):
                region["selected"] = True
                region["label"] = "邻近推广文字的二维码，建议遮除"
    except (OSError, subprocess.TimeoutExpired, ValueError, json.JSONDecodeError):
        notice = "本页 OCR 未完成，可使用二维码候选框或手动框选。"
    finally:
        if "ocr_file" in locals():
            ocr_file.unlink(missing_ok=True)
    result = dict(regions=regions, notice=notice, width=width, height=height)
    cache_file = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            dir=private,
            prefix="cleanup-",
            suffix=".tmp",
            encoding="utf-8",
            delete=False,
        ) as temporary:
            cache_file = Path(temporary.name)
            json.dump(result, temporary, ensure_ascii=False)
        for attempt in range(5):
            try:
                os.replace(cache_file, cached)
                break
            except PermissionError as error:
                # Windows readers or scanners may briefly hold the old cache.
                if getattr(error, "winerror", None) not in (5, 32, 33) or attempt == 4:
                    raise
                time.sleep(0.01 * (2**attempt))
    finally:
        if cache_file is not None:
            cache_file.unlink(missing_ok=True)
    return result
