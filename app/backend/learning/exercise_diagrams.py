"""Bounded diagram specifications: the same drawing is reviewed and shown to pupils."""

import io, math, re
from PIL import Image, ImageDraw, ImageFont


def validate_diagram(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("图示结构不正确")
    kind = value.get("kind")
    clean = dict(kind=kind)

    def number(name, lo, hi, source=value):
        n = source.get(name)
        if type(n) not in [int, float] or not lo <= n <= hi or not math.isfinite(n):
            raise ValueError("图示尺寸或数值不正确")
        return n

    if kind == "blocks":
        cubes = value.get("cubes")
        if not isinstance(cubes, list) or not 1 <= len(cubes) <= 15:
            raise ValueError("积木图数量不正确")
        clean["cubes"] = []
        seen = set()
        for cube in cubes:
            if not isinstance(cube, dict):
                raise ValueError("积木坐标不正确")
            xyz = tuple(number(axis, 0, 3, cube) for axis in ["x", "y", "z"])
            if any(type(n) != int for n in xyz) or xyz in seen:
                raise ValueError("积木必须是不同的整数坐标")
            seen.add(xyz)
            clean["cubes"].append(dict(zip(["x", "y", "z"], xyz)))
        if any(z > 0 and (x, y, z - 1) not in seen for x, y, z in seen):
            raise ValueError("积木不能悬空")
    elif kind == "clock":
        clean.update(hour=number("hour", 1, 12), minute=number("minute", 0, 59))
        if any(type(clean[n]) != int for n in ["hour", "minute"]):
            raise ValueError("时钟刻度不正确")
    elif kind == "fraction":
        clean.update(
            numerator=number("numerator", 0, 12),
            denominator=number("denominator", 1, 12),
        )
        if (
            any(type(clean[n]) != int for n in ["numerator", "denominator"])
            or clean["numerator"] > clean["denominator"]
        ):
            raise ValueError("分数图不正确")
    elif kind == "chart":
        values = value.get("values")
        if not isinstance(values, list) or not 2 <= len(values) <= 6:
            raise ValueError("统计图数据不完整")
        clean["values"] = [number("value", 0, 1000, dict(value=v)) for v in values]
    elif kind == "table":
        headers = value.get("headers")
        rows = value.get("rows")
        if (
            not isinstance(headers, list)
            or not 2 <= len(headers) <= 4
            or not isinstance(rows, list)
            or not 1 <= len(rows) <= 6
        ):
            raise ValueError("信息表须为2到4列、1到6行")

        def cell(text):
            if (
                not isinstance(text, str)
                or not text.strip()
                or len(text) > 32
                or not re.fullmatch(r"[A-Za-z0-9 .'\u2019,:?!()/%+-]+", text)
            ):
                raise ValueError("信息表仅支持清晰的短英文或数字，中文说明放在题干")
            return text.strip()

        clean["headers"] = [cell(v) for v in headers]
        clean["rows"] = []
        if len({v.casefold() for v in clean["headers"]}) != len(headers):
            raise ValueError("信息表表头不能重复")
        for row in rows:
            if not isinstance(row, list) or len(row) != len(headers):
                raise ValueError("信息表行列未对齐")
            clean["rows"].append([cell(v) for v in row])
    elif kind == "geometry":
        shapes = value.get("shapes")
        if not isinstance(shapes, list) or not 1 <= len(shapes) <= 10:
            raise ValueError("几何图数量不正确")
        clean["shapes"] = []
        for shape in shapes:
            if not isinstance(shape, dict):
                raise ValueError("图形格式不正确")
            typ = shape.get("type")
            label = shape.get("label", "")
            if not isinstance(label, str) or not re.fullmatch(
                r"[A-Za-z0-9 .+×÷=/:%°-]{0,18}", label
            ):
                raise ValueError("图中只使用短字母或数字标注，文字说明请写在题干")
            obj = dict(type=typ, label=label)
            if typ == "rect":
                obj.update(
                    {
                        n: number(n, 0 if n in ["x", "y"] else 1, 100, shape)
                        for n in ["x", "y", "w", "h"]
                    }
                )
                if obj["x"] + obj["w"] > 100 or obj["y"] + obj["h"] > 100:
                    raise ValueError("图形越界")
            elif typ == "circle":
                obj.update({n: number(n, 1, 99, shape) for n in ["x", "y", "r"]})
                if (
                    obj["x"] - obj["r"] < 0
                    or obj["x"] + obj["r"] > 100
                    or obj["y"] - obj["r"] < 0
                    or obj["y"] + obj["r"] > 100
                ):
                    raise ValueError("圆形越界")
            elif typ == "line":
                obj.update(
                    {n: number(n, 0, 100, shape) for n in ["x1", "y1", "x2", "y2"]}
                )
                if math.hypot(obj["x2"] - obj["x1"], obj["y2"] - obj["y1"]) < 0.1:
                    raise ValueError("线段长度过小")
            elif typ == "polygon":
                points = shape.get("points")
                if not isinstance(points, list) or not 3 <= len(points) <= 6:
                    raise ValueError("多边形点数不正确")
                obj["points"] = []
                for point in points:
                    if not isinstance(point, list) or len(point) != 2:
                        raise ValueError("多边形坐标不正确")
                    obj["points"].append(
                        [
                            number("x", 0, 100, dict(x=point[0])),
                            number("y", 0, 100, dict(y=point[1])),
                        ]
                    )
                polygon = obj["points"]
                if len({tuple(p) for p in polygon}) != len(polygon):
                    raise ValueError("多边形顶点重复")
                area = (
                    abs(
                        sum(
                            polygon[i][0] * polygon[(i + 1) % len(polygon)][1]
                            - polygon[(i + 1) % len(polygon)][0] * polygon[i][1]
                            for i in range(len(polygon))
                        )
                    )
                    / 2
                )
                if area < 0.1:
                    raise ValueError("多边形不能退化为直线")

                def cross(a, b, c):
                    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

                def intersects(a, b, c, d):
                    signs = [
                        cross(a, b, c),
                        cross(a, b, d),
                        cross(c, d, a),
                        cross(c, d, b),
                    ]
                    if signs[0] * signs[1] < 0 and signs[2] * signs[3] < 0:
                        return True
                    return any(
                        abs(turn) < 1e-9
                        and min(start[0], end[0]) <= point[0] <= max(start[0], end[0])
                        and min(start[1], end[1]) <= point[1] <= max(start[1], end[1])
                        for turn, start, end, point in [
                            (signs[0], a, b, c),
                            (signs[1], a, b, d),
                            (signs[2], c, d, a),
                            (signs[3], c, d, b),
                        ]
                    )

                for i in range(len(polygon)):
                    for j in range(i + 1, len(polygon)):
                        if j == i + 1 or i == 0 and j == len(polygon) - 1:
                            continue
                        if intersects(
                            polygon[i],
                            polygon[(i + 1) % len(polygon)],
                            polygon[j],
                            polygon[(j + 1) % len(polygon)],
                        ):
                            raise ValueError("多边形边不能交叉")
            else:
                raise ValueError("不支持的图形")
            clean["shapes"].append(obj)
    else:
        raise ValueError("不支持的图示类型")
    return clean


def render_diagram(spec):
    spec = validate_diagram(spec)
    if not spec:
        raise ValueError("本题没有图示")
    im = Image.new("RGB", (600, 380), "white")
    d = ImageDraw.Draw(im)
    ink = "#28394f"
    blue = "#6799d4"
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 21)
    except OSError:
        font = ImageFont.load_default(size=20)

    def text(point, value):
        value = str(value)
        box = d.textbbox((0, 0), value, font=font, anchor="mm")
        x, y = point
        x = max(8 - box[0], min(592 - box[2], x))
        y = max(8 - box[1], min(372 - box[3], y))
        d.text((x, y), value, font=font, fill=ink, anchor="mm")

    kind = spec["kind"]
    if kind == "blocks":
        cubes = spec["cubes"]
        centers = [(c["x"] - c["y"], c["x"] + c["y"] - 2 * c["z"]) for c in cubes]
        minx = min(x for x, y in centers)
        maxx = max(x for x, y in centers)
        miny = min(y for x, y in centers)
        maxy = max(y for x, y in centers)
        size = min(
            50, 450 / max(3, maxx - minx + 2), 270 / max(3, (maxy - miny) * 0.5 + 2)
        )

        def point(x, y, z):
            return (
                300 + (x - y - (minx + maxx) / 2) * size,
                170 + (x + y - 2 * z - (miny + maxy) / 2) * size * 0.5,
            )

        for c in sorted(cubes, key=lambda c: (c["x"] + c["y"], c["z"])):
            x, y, z = c["x"], c["y"], c["z"]
            top = [
                point(x, y, z + 1),
                point(x + 1, y, z + 1),
                point(x + 1, y + 1, z + 1),
                point(x, y + 1, z + 1),
            ]
            right = [
                point(x + 1, y, z),
                point(x + 1, y + 1, z),
                point(x + 1, y + 1, z + 1),
                point(x + 1, y, z + 1),
            ]
            left = [
                point(x, y + 1, z),
                point(x + 1, y + 1, z),
                point(x + 1, y + 1, z + 1),
                point(x, y + 1, z + 1),
            ]
            for poly, fill in [(right, "#c9d8eb"), (left, "#eef3f9"), (top, "#ffffff")]:
                d.polygon(poly, fill=fill, outline=ink, width=2)
        text((300, 350), "3D")
    elif kind == "clock":
        cx, cy, r = 300, 184, 145
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=ink, width=3)
        for n in range(1, 13):
            angle = n * math.pi / 6
            text((cx + math.sin(angle) * (r - 25), cy - math.cos(angle) * (r - 25)), n)
        for angle, length, width in [
            ((spec["hour"] % 12 + spec["minute"] / 60) * math.pi / 6, 75, 7),
            (spec["minute"] * math.pi / 30, 108, 4),
        ]:
            d.line(
                (cx, cy, cx + math.sin(angle) * length, cy - math.cos(angle) * length),
                fill=ink,
                width=width,
            )
        d.ellipse((cx - 5, cy - 5, cx + 5, cy + 5), fill=ink)
    elif kind == "fraction":
        n = spec["denominator"]
        for i in range(n):
            d.pieslice(
                (135, 25, 465, 355),
                -90 + i * 360 / n,
                -90 + (i + 1) * 360 / n,
                fill=blue if i < spec["numerator"] else "#ffffff",
                outline=ink,
                width=2,
            )
    elif kind == "chart":
        values = spec["values"]
        top = max(1, max(values))
        d.line((60, 30, 60, 320, 560, 320), fill=ink, width=2)
        for i, value in enumerate(values):
            x = 85 + i * 460 / len(values)
            height = value / top * 240
            d.rectangle(
                (x, 320 - height, x + 280 / len(values), 320), fill=blue, outline=ink
            )
            text((x + 140 / len(values), 340), chr(65 + i))
            text((x + 140 / len(values), max(18, 305 - height)), value)
    elif kind == "table":
        rows = [spec["headers"], *spec["rows"]]
        width = 560 / len(spec["headers"])
        height = min(72, 330 / len(rows))
        top = (380 - height * len(rows)) / 2
        for ri, row in enumerate(rows):
            for ci, value in enumerate(row):
                x = 20 + ci * width
                y = top + ri * height
                d.rectangle(
                    (x, y, x + width, y + height),
                    fill="#eef3f9" if ri == 0 else "white",
                    outline=ink,
                    width=2,
                )
                # Wrap by measured pixels. Reject no content silently, and keep
                # the bounded cells readable when a phone scales the image.
                try:
                    cell_font = ImageFont.truetype("DejaVuSans.ttf", 24)
                except OSError:
                    cell_font = ImageFont.load_default(size=24)
                lines = [""]
                for word in value.split(" "):
                    trial = (lines[-1] + " " + word).strip()
                    if d.textlength(trial, font=cell_font) > width - 16 and lines[-1]:
                        lines.append(word)
                    else:
                        lines[-1] = trial
                if (
                    any(
                        d.textlength(line, font=cell_font) > width - 16
                        for line in lines
                    )
                    or len(lines) * 28 > height - 8
                ):
                    raise ValueError("信息表文字超出可读范围，请缩短单元格内容")
                for line_index, line in enumerate(lines):
                    d.text(
                        (
                            x + width / 2,
                            y + height / 2 + (line_index - (len(lines) - 1) / 2) * 28,
                        ),
                        line,
                        font=cell_font,
                        fill=ink,
                        anchor="mm",
                    )
    else:
        # Geometry uses a square coordinate plane: equal lengths must remain equal
        # on screen, otherwise a model's square would be shown as a rectangle.
        def p(x, y):
            return (140 + x * 3.2, 25 + y * 3.2)

        for shape in spec["shapes"]:
            typ = shape["type"]
            if typ == "rect":
                a = p(shape["x"], shape["y"])
                b = p(shape["x"] + shape["w"], shape["y"] + shape["h"])
                d.rectangle((*a, *b), outline=ink, width=3)
                label = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            elif typ == "circle":
                x, y = p(shape["x"], shape["y"])
                r = shape["r"] * 3.2
                d.ellipse((x - r, y - r, x + r, y + r), outline=ink, width=3)
                label = (x, y)
            elif typ == "line":
                a = p(shape["x1"], shape["y1"])
                b = p(shape["x2"], shape["y2"])
                d.line((*a, *b), fill=ink, width=3)
                label = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 15)
            else:
                points = [p(*v) for v in shape["points"]]
                d.polygon(points, outline=ink, width=3)
                label = (
                    sum(v[0] for v in points) / len(points),
                    sum(v[1] for v in points) / len(points),
                )
            if shape["label"]:
                text(label, shape["label"])
    out = io.BytesIO()
    im.save(out, "PNG", optimize=True)
    im.close()
    return out.getvalue()
