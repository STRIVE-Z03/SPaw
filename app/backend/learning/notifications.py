"""Broadcast notices and per-account read state."""

import base64
import binascii
import io
import re
import time

from PIL import Image, ImageOps, UnidentifiedImageError


ID = re.compile(r"[a-f0-9]{32}")
IMAGE_PREFIX = re.compile(r"data:image/(?:png|jpeg|webp);base64,")
MAX_IMAGE_BYTES = 2 * 1024 * 1024
PAGE_SIZE = 12


def paragraphs(body):
    """Preserve author breaks and wrap extended prose between sentences."""
    result = []
    for block in re.split(r"\n\s*\n", body):
        block = block.strip()
        while len(block) > 210:
            window = block[:210]
            boundary = max(window.rfind(mark) for mark in "。！？；!?;，, \n")
            stop = boundary + 1 if boundary >= 75 else 210
            result.append(block[:stop].strip())
            block = block[stop:].lstrip()
        if block:
            result.append(block)
    return result


def prepare_image(value):
    if value in (None, ""):
        return None
    if not isinstance(value, str) or len(value) > 4 * ((MAX_IMAGE_BYTES + 2) // 3) + 40:
        raise ValueError("请选择不超过 2 MB 的图片")
    prefix = IMAGE_PREFIX.match(value)
    if not prefix:
        raise ValueError("图片需为 JPG、PNG 或 WebP")
    try:
        data = base64.b64decode(value[prefix.end() :], validate=True)
        if len(data) > MAX_IMAGE_BYTES:
            raise ValueError("请选择不超过 2 MB 的图片")
        with Image.open(io.BytesIO(data), formats=("JPEG", "PNG", "WEBP")) as image:
            if image.width * image.height > 12_000_000:
                raise ValueError("图片尺寸过大")
            clean = ImageOps.exif_transpose(image).convert("RGB")
            clean.thumbnail((1280, 1280))
            output = io.BytesIO()
            clean.save(output, "WEBP", quality=82)
            return output.getvalue()
    except (
        UnidentifiedImageError,
        binascii.Error,
        Image.DecompressionBombError,
        OSError,
    ):
        raise ValueError("这张图片无法读取，请换一张") from None


class Notifications:
    def __init__(self, db, clock=time.time):
        self.db, self.clock = db, clock
        with db() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS notifications (
                    id TEXT PRIMARY KEY,
                    author_id INTEGER NOT NULL REFERENCES users(id),
                    title TEXT NOT NULL, body TEXT NOT NULL, image BLOB, published_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS notifications_published
                    ON notifications(published_at DESC,id DESC);
                CREATE TABLE IF NOT EXISTS notification_reads (
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
                    PRIMARY KEY(user_id,notification_id)
                );
                CREATE INDEX IF NOT EXISTS notification_reads_by_notice
                    ON notification_reads(notification_id);
            """)

    @staticmethod
    def _identity(value):
        if not isinstance(value, str) or not ID.fullmatch(value):
            raise ValueError("通知编号不正确")
        return value

    @staticmethod
    def _admin(actor):
        if actor["role"] != "admin":
            raise PermissionError("仅管理员可管理通知")

    @staticmethod
    def _content(body):
        title, content = body.get("title"), body.get("body")
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 90:
            raise ValueError("请填写 1 至 90 字的标题")
        if not isinstance(content, str) or not 1 <= len(content.strip()) <= 12000:
            raise ValueError("请填写 1 至 12000 字的正文")
        title = title.strip()
        content = content.replace("\r\n", "\n").replace("\r", "\n").strip()
        return title, content

    def publish(self, actor, body):
        self._admin(actor)
        identity = self._identity(body.get("requestId"))
        title, content = self._content(body)
        image = prepare_image(body.get("image"))
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            old = conn.execute(
                "SELECT author_id,title,body,image FROM notifications WHERE id=?",
                (identity,),
            ).fetchone()
            if old:
                if (old["author_id"], old["title"], old["body"], old["image"]) != (
                    actor["id"],
                    title,
                    content,
                    image,
                ):
                    raise ValueError("通知内容已变化，请重新提交")
            else:
                conn.execute(
                    "INSERT INTO notifications VALUES(?,?,?,?,?,?)",
                    (identity, actor["id"], title, content, image, int(self.clock())),
                )
        return {"id": identity}

    def edit(self, actor, identity, body):
        self._admin(actor)
        self._identity(identity)
        title, content = self._content(body)
        replace_image = "image" in body
        image = prepare_image(body["image"]) if replace_image else None
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            count = conn.execute(
                """UPDATE notifications
                SET title=?, body=?, image=CASE WHEN ? THEN ? ELSE image END WHERE id=?""",
                (title, content, replace_image, image, identity),
            ).rowcount
            if not count:
                raise ValueError("没有找到该通知")
        return {"id": identity}

    def delete(self, actor, identity):
        self._admin(actor)
        with self.db() as conn:
            conn.execute(
                "DELETE FROM notifications WHERE id=?", (self._identity(identity),)
            )
        return {"ok": True}

    def admin_detail(self, actor, identity):
        self._admin(actor)
        with self.db() as conn:
            row = conn.execute(
                """SELECT id,title,body,published_at,image IS NOT NULL AS hasImage
                FROM notifications WHERE id=?""",
                (self._identity(identity),),
            ).fetchone()
        if not row:
            raise ValueError("没有找到该通知")
        return {
            **dict(row),
            "imageUrl": f"/api/notifications/{identity}/image"
            if row["hasImage"]
            else None,
        }

    @staticmethod
    def _unread(conn, uid):
        return conn.execute(
            """
            SELECT (SELECT COUNT(*) FROM notifications)
                 - (SELECT COUNT(*) FROM notification_reads WHERE user_id=?)
        """,
            (uid,),
        ).fetchone()[0]

    def unread(self, uid):
        with self.db() as conn:
            return {"unread": self._unread(conn, uid)}

    def listing(self, uid, page):
        page = int(page)
        if not 0 <= page <= 100000:
            raise ValueError("页码不正确")
        with self.db() as conn:
            conn.execute("BEGIN")
            items = conn.execute(
                """
                SELECT n.id,n.title,n.published_at,substr(n.body,1,96) AS preview,
                       n.image IS NOT NULL AS hasImage,r.notification_id IS NULL AS unread
                FROM notifications n LEFT JOIN notification_reads r
                  ON r.user_id=? AND r.notification_id=n.id
                ORDER BY n.published_at DESC,n.id DESC LIMIT ? OFFSET ?
            """,
                (uid, PAGE_SIZE + 1, page * PAGE_SIZE),
            ).fetchall()
            return {
                "items": [dict(row) for row in items[:PAGE_SIZE]],
                "more": len(items) > PAGE_SIZE,
                "unread": self._unread(conn, uid),
            }

    def open(self, uid, identity):
        self._identity(identity)
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """
                SELECT id,title,body,published_at,image IS NOT NULL AS hasImage
                FROM notifications WHERE id=?
            """,
                (identity,),
            ).fetchone()
            if not row:
                raise ValueError("没有找到该通知")
            conn.execute(
                "INSERT OR IGNORE INTO notification_reads VALUES(?,?)", (uid, identity)
            )
            unread = self._unread(conn, uid)
        return {
            "id": identity,
            "title": row["title"],
            "published_at": row["published_at"],
            "paragraphs": paragraphs(row["body"]),
            "unread": unread,
            "imageUrl": f"/api/notifications/{identity}/image"
            if row["hasImage"]
            else None,
        }

    def image(self, identity):
        with self.db() as conn:
            row = conn.execute(
                "SELECT image FROM notifications WHERE id=?",
                (self._identity(identity),),
            ).fetchone()
        return row["image"] if row else None
