"""会员、兑换码与服务端额度。时间使用 UTC 时间戳，额度按北京时间自然日/月。"""

import hashlib
import re
import secrets
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

SHANGHAI = timezone(timedelta(hours=8))
LIMITS = {
    "free": {"scan": 5, "ai": 15},
    "vip": {"general": 300, "dictation": 500, "arena": 300},
    "svip": {"general": 800, "dictation": 1500, "arena": 500},
}


class Membership:
    def __init__(self, db, clock=time.time):
        self.db, self.clock = db, clock
        with db() as conn:
            conn.executescript("""
            CREATE TABLE IF NOT EXISTS memberships(user_id INTEGER PRIMARY KEY, tier TEXT NOT NULL, starts INTEGER NOT NULL, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS membership_codes(id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, suffix TEXT NOT NULL, batch TEXT NOT NULL, tier TEXT NOT NULL, days INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER, disabled INTEGER NOT NULL DEFAULT 0, used_by INTEGER, used_at INTEGER, note TEXT NOT NULL DEFAULT '');
            CREATE TABLE IF NOT EXISTS membership_usage(user_id INTEGER NOT NULL, request_id TEXT NOT NULL, bucket TEXT NOT NULL, period TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(user_id,request_id));
            CREATE INDEX IF NOT EXISTS membership_usage_period ON membership_usage(user_id,bucket,period,status);
            CREATE TABLE IF NOT EXISTS membership_purchase(tier TEXT PRIMARY KEY, platform TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS membership_audit(id INTEGER PRIMARY KEY, actor INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS membership_attempts(user_id INTEGER PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS membership_dictation_keys(user_id INTEGER NOT NULL, request_id TEXT NOT NULL, word_hash TEXT NOT NULL, PRIMARY KEY(user_id, request_id));
            """)

    @staticmethod
    def _tier(conn, uid, now):
        row = conn.execute(
            "SELECT * FROM memberships WHERE user_id=?", (uid,)
        ).fetchone()
        return dict(row) if row and row["expires"] > now else None

    def _period(self, bucket):
        date = datetime.fromtimestamp(self.clock(), SHANGHAI)
        return date.strftime("%Y-%m-%d" if bucket == "scan" else "%Y-%m")

    def status(self, uid):
        now = int(self.clock())
        with self.db() as conn:
            active = self._tier(conn, uid, now)
            prior = conn.execute(
                "SELECT * FROM memberships WHERE user_id=?", (uid,)
            ).fetchone()
            tier = active["tier"] if active else "free"
            quotas = {}
            for bucket, limit in LIMITS[tier].items():
                period = self._period(bucket)
                used = conn.execute(
                    "SELECT COUNT(*) FROM membership_usage WHERE user_id=? AND bucket=? AND period=? AND status IN ('reserved','done')",
                    (uid, bucket, period),
                ).fetchone()[0]
                quotas[bucket] = dict(
                    limit=limit,
                    used=used,
                    remaining=max(0, limit - used),
                    period=period,
                )
            purchases = [
                dict(r)
                for r in conn.execute(
                    "SELECT tier,platform,url,instructions,enabled FROM membership_purchase WHERE enabled=1"
                )
            ]
            return dict(
                tier=tier,
                starts=active["starts"] if active else None,
                expires=active["expires"] if active else None,
                expired=bool(prior and not active),
                lastTier=prior["tier"] if prior else None,
                lastExpires=prior["expires"] if prior else None,
                quotas=quotas,
                purchases=purchases,
            )

    def require_vip(self, uid):
        with self.db() as conn:
            if not self._tier(conn, uid, int(self.clock())):
                raise PermissionError(
                    "此功能需要爪爪 VIP 或 SVIP，请前往会员中心兑换。"
                )

    def reserve(self, conn, uid, request_id, kind):
        """Caller owns an immediate transaction. Stable request IDs make retries idempotent."""
        now = int(self.clock())
        active = self._tier(conn, uid, now)
        tier = active["tier"] if active else "free"
        if kind in ("arena", "dictation") and not active:
            raise PermissionError("此功能需要爪爪 VIP 或 SVIP，请前往会员中心兑换。")
        bucket = (
            kind if kind in ("arena", "dictation") else ("general" if active else kind)
        )
        if bucket not in LIMITS[tier]:
            raise ValueError("额度类型不正确")
        existing = conn.execute(
            "SELECT * FROM membership_usage WHERE user_id=? AND request_id=?",
            (uid, request_id),
        ).fetchone()
        if existing and existing["status"] in ("reserved", "done"):
            if existing["bucket"] != bucket:
                raise ValueError("请求编号已被使用")
            return
        period = self._period(bucket)
        used = conn.execute(
            "SELECT COUNT(*) FROM membership_usage WHERE user_id=? AND bucket=? AND period=? AND status IN ('reserved','done')",
            (uid, bucket, period),
        ).fetchone()[0]
        if used >= LIMITS[tier][bucket]:
            raise PermissionError("当前额度已用完，请等待重置或查看会员权益。")
        conn.execute(
            "INSERT OR REPLACE INTO membership_usage VALUES(?,?,?,?,?,?)",
            (uid, request_id, bucket, period, "reserved", now),
        )

    @staticmethod
    def settle(conn, uid, request_id, success):
        conn.execute(
            "UPDATE membership_usage SET status=? WHERE user_id=? AND request_id=? AND status='reserved'",
            ("done" if success else "released", uid, request_id),
        )

    def consume_word(self, uid, request_id, text, language):
        if not isinstance(request_id, str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{8,120}", request_id
        ):
            raise ValueError("听写请求编号不正确")
        if not isinstance(text, str):
            raise ValueError("听写词语不正确")
        text = unicodedata.normalize("NFC", " ".join(text.split()))
        if not text or len(text) > 120 or any(ord(ch) < 32 for ch in text):
            raise ValueError("听写词语不正确")
        if not isinstance(language, str):
            raise ValueError("听写语言不正确")
        languages = {
            "zh": "zh-CN",
            "zh-cn": "zh-CN",
            "en": "en-GB",
            "en-gb": "en-GB",
            "en-us": "en-US",
        }
        language = languages.get(language.lower().replace("_", "-"))
        if not language:
            raise ValueError("听写语言不正确")
        word_hash = hashlib.sha256((language + "\0" + text).encode("utf-8")).hexdigest()
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            binding = conn.execute(
                "SELECT word_hash FROM membership_dictation_keys WHERE user_id=? AND request_id=?",
                (uid, request_id),
            ).fetchone()
            if binding and binding["word_hash"] != word_hash:
                raise ValueError("听写请求编号已用于其他词语，请重新开始当前词语")
            if not binding:
                old = conn.execute(
                    "SELECT 1 FROM membership_usage WHERE user_id=? AND request_id=?",
                    (uid, "dictation:" + request_id),
                ).fetchone()
                if old:
                    raise ValueError("旧听写记录需要刷新后重新开始")
                conn.execute(
                    "INSERT INTO membership_dictation_keys VALUES(?,?,?)",
                    (uid, request_id, word_hash),
                )
            self.reserve(conn, uid, "dictation:" + request_id, "dictation")
            self.settle(conn, uid, "dictation:" + request_id, True)
        return self.status(uid)

    def generate(self, actor, data):
        tier, days, quantity = data.get("tier"), data.get("days"), data.get("quantity")
        batch, note, expires = (
            data.get("batch", ""),
            data.get("note", ""),
            data.get("expires"),
        )
        if (
            tier not in ("vip", "svip")
            or type(days) is not int
            or not 1 <= days <= 3660
            or type(quantity) is not int
            or not 1 <= quantity <= 1000
        ):
            raise ValueError("会员类型、时长或数量不正确")
        if (
            not isinstance(batch, str)
            or not batch.strip()
            or len(batch) > 80
            or not isinstance(note, str)
            or len(note) > 200
        ):
            raise ValueError("请填写不超过 80 字的批次名称")
        now = int(self.clock())
        if expires is not None and (type(expires) is not int or expires <= now):
            raise ValueError("兑换截止时间必须晚于当前时间")
        values = []
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            for _ in range(quantity):
                raw = secrets.token_hex(12).upper()
                code = "-".join(raw[i : i + 4] for i in range(0, len(raw), 4))
                values.append(code)
                conn.execute(
                    "INSERT INTO membership_codes(code_hash,suffix,batch,tier,days,created,expires,note) VALUES(?,?,?,?,?,?,?,?)",
                    (
                        hashlib.sha256(raw.encode()).hexdigest(),
                        raw[-4:],
                        batch.strip(),
                        tier,
                        days,
                        now,
                        expires,
                        note,
                    ),
                )
            conn.execute(
                "INSERT INTO membership_audit(actor,action,target,at) VALUES(?,?,?,?)",
                (actor, "generate", batch.strip(), now),
            )
        return dict(codes=values, notice="完整兑换码仅在本次显示，请安全保存。")

    def redeem(self, uid, raw, actor):
        if not isinstance(raw, str):
            raise ValueError("兑换码格式不正确")
        code = re.sub(r"[\s-]", "", raw).upper()
        if not re.fullmatch(r"[A-F0-9]{24}", code):
            raise ValueError("兑换码格式不正确")
        now = int(self.clock())
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            attempts = conn.execute(
                "SELECT * FROM membership_attempts WHERE user_id=?", (actor,)
            ).fetchone()
            if attempts and attempts["until_at"] > now and attempts["count"] >= 10:
                raise PermissionError("尝试次数过多，请稍后再试")
            row = conn.execute(
                "SELECT * FROM membership_codes WHERE code_hash=?",
                (hashlib.sha256(code.encode()).hexdigest(),),
            ).fetchone()
            if (
                not row
                or row["used_by"] is not None
                or row["disabled"]
                or (row["expires"] and row["expires"] <= now)
            ):
                count = (
                    attempts["count"] if attempts and attempts["until_at"] > now else 0
                ) + 1
                conn.execute(
                    "INSERT OR REPLACE INTO membership_attempts VALUES(?,?,?)",
                    (actor, count, now + 300),
                )
                invalid = True
            else:
                invalid = False
                active = self._tier(conn, uid, now)
                if active and active["tier"] != row["tier"]:
                    raise ValueError("当前会员尚未到期，请到期后兑换其他等级。")
                starts = active["starts"] if active else now
                expires = (active["expires"] if active else now) + row["days"] * 86400
                conn.execute(
                    "INSERT OR REPLACE INTO memberships VALUES(?,?,?,?)",
                    (uid, row["tier"], starts, expires),
                )
                conn.execute(
                    "UPDATE membership_codes SET used_by=?,used_at=? WHERE id=? AND used_by IS NULL",
                    (uid, now, row["id"]),
                )
                conn.execute(
                    "DELETE FROM membership_attempts WHERE user_id=?", (actor,)
                )
                conn.execute(
                    "INSERT INTO membership_audit(actor,action,target,at) VALUES(?,?,?,?)",
                    (actor, "redeem", str(row["id"]), now),
                )
        if invalid:
            raise ValueError("兑换码无效、已使用、已过期或已停用")
        return self.status(uid)

    def codes(self, status="", search="", offset=0):
        if (
            not isinstance(search, str)
            or len(search) > 80
            or status not in ("", "used", "unused", "expired", "disabled")
        ):
            raise ValueError("搜索内容不正确")
        try:
            offset = int(offset)
        except (TypeError, ValueError):
            raise ValueError("分页参数不正确") from None
        if not 0 <= offset <= 1000000:
            raise ValueError("分页参数不正确")
        now = int(self.clock())
        filters = {
            "used": "c.used_by IS NOT NULL",
            "disabled": "c.used_by IS NULL AND c.disabled=1",
            "expired": "c.used_by IS NULL AND c.disabled=0 AND c.expires IS NOT NULL AND c.expires<=?",
            "unused": "c.used_by IS NULL AND c.disabled=0 AND (c.expires IS NULL OR c.expires>?)",
        }
        where = "(c.batch LIKE ? OR u.username LIKE ?)"
        args = ["%" + search + "%", "%" + search + "%"]
        if status:
            where += " AND " + filters[status]
            if status in ("expired", "unused"):
                args.append(now)
        with self.db() as conn:
            rows = [
                dict(r)
                for r in conn.execute(
                    "SELECT c.id,c.suffix,c.batch,c.tier,c.days,c.created,c.expires,c.disabled,c.used_by,c.used_at,c.note,u.username,u.child_name FROM membership_codes c LEFT JOIN users u ON u.id=c.used_by WHERE "
                    + where
                    + " ORDER BY c.id DESC LIMIT 51 OFFSET ?",
                    (*args, offset),
                )
            ]
        for row in rows:
            row["status"] = (
                "used"
                if row["used_by"] is not None
                else "disabled"
                if row["disabled"]
                else "expired"
                if row["expires"] and row["expires"] <= now
                else "unused"
            )
        return rows

    def update_code(self, actor, data):
        identity, action = data.get("id"), data.get("action")
        if type(identity) is not int or action not in (
            "disable",
            "enable",
            "delete",
            "edit",
        ):
            raise ValueError("操作不正确")
        now = int(self.clock())
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM membership_codes WHERE id=?", (identity,)
            ).fetchone()
            if not row:
                raise ValueError("兑换码不存在")
            if row["used_by"] is not None:
                raise ValueError("已使用的兑换码不能修改或删除")
            if action == "delete":
                conn.execute("DELETE FROM membership_codes WHERE id=?", (identity,))
            elif action in ("disable", "enable"):
                conn.execute(
                    "UPDATE membership_codes SET disabled=? WHERE id=?",
                    (int(action == "disable"), identity),
                )
            else:
                note = data.get("note", "")
                expires = data.get("expires")
                if (
                    not isinstance(note, str)
                    or len(note) > 200
                    or (
                        expires is not None
                        and (type(expires) is not int or expires <= now)
                    )
                ):
                    raise ValueError("备注或兑换截止时间不正确")
                conn.execute(
                    "UPDATE membership_codes SET note=?,expires=? WHERE id=?",
                    (note, expires, identity),
                )
            conn.execute(
                "INSERT INTO membership_audit(actor,action,target,at) VALUES(?,?,?,?)",
                (actor, action, str(identity), now),
            )
        return dict(ok=True)

    def purchase(self, actor, data):
        tier, platform, url, instructions, enabled = (
            data.get(k) for k in ("tier", "platform", "url", "instructions", "enabled")
        )
        if (
            tier not in ("vip", "svip")
            or type(enabled) is not bool
            or any(not isinstance(v, str) for v in (platform, url, instructions))
            or len(platform) > 80
            or len(url) > 1000
            or len(instructions) > 1000
        ):
            raise ValueError("购买配置不正确")
        parsed = urlsplit(url)
        if url and (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            raise ValueError("购买地址必须是有效的 HTTPS 地址")
        if enabled and not url:
            raise ValueError("启用前请填写购买地址")
        with self.db() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO membership_purchase VALUES(?,?,?,?,?)",
                (tier, platform, url, instructions, int(enabled)),
            )
            conn.execute(
                "INSERT INTO membership_audit(actor,action,target,at) VALUES(?,?,?,?)",
                (actor, "purchase_config", tier, int(self.clock())),
            )
        return dict(ok=True)

    def set_membership(self, actor, data):
        uid, tier, expires = data.get("userId"), data.get("tier"), data.get("expires")
        now = int(self.clock())
        if (
            type(uid) is not int
            or uid < 1
            or tier not in ("free", "vip", "svip")
            or type(expires) is not int
        ):
            raise ValueError("会员设置不正确")
        if expires == 0:
            tier = "free"
        elif tier == "free" or expires <= now or expires > now + 3660 * 86400:
            raise ValueError("会员到期时间必须在未来十年内；取消会员请设置为 0")
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            user = conn.execute(
                "SELECT id FROM users WHERE id=? AND role='child' AND enabled=1", (uid,)
            ).fetchone()
            if not user:
                raise ValueError("宝宝账号不存在或已停用")
            old = conn.execute(
                "SELECT tier,expires FROM memberships WHERE user_id=?", (uid,)
            ).fetchone()
            if tier == "free":
                conn.execute("DELETE FROM memberships WHERE user_id=?", (uid,))
            else:
                conn.execute(
                    "INSERT OR REPLACE INTO memberships VALUES(?,?,?,?)",
                    (uid, tier, now, expires),
                )
            previous = f"{old['tier']}:{old['expires']}" if old else "free:0"
            conn.execute(
                "INSERT INTO membership_audit(actor,action,target,at) VALUES(?,?,?,?)",
                (actor, "set_membership", f"{uid} {previous} -> {tier}:{expires}", now),
            )
        return self.status(uid)

    def admin_data(self, search="", offset=0):
        if not isinstance(search, str) or len(search) > 80:
            raise ValueError("搜索内容不正确")
        try:
            offset = int(offset)
        except (TypeError, ValueError):
            raise ValueError("分页参数不正确") from None
        if not 0 <= offset <= 1000000:
            raise ValueError("分页参数不正确")
        with self.db() as conn:
            purchases = [
                dict(r) for r in conn.execute("SELECT * FROM membership_purchase")
            ]
            audit = [
                dict(r)
                for r in conn.execute(
                    "SELECT a.*,u.username FROM membership_audit a LEFT JOIN users u ON u.id=a.actor ORDER BY a.id DESC LIMIT 100"
                )
            ]
            users = [
                dict(r)
                for r in conn.execute(
                    "SELECT id,username,child_name FROM users WHERE role='child' AND enabled=1 AND (username LIKE ? OR child_name LIKE ?) ORDER BY id LIMIT 51 OFFSET ?",
                    ("%" + search + "%", "%" + search + "%", offset),
                )
            ]
        has_more = len(users) > 50
        users = users[:50]
        for user in users:
            user["membership"] = self.status(user["id"])
        return dict(
            users=users, usersHasMore=has_more, purchases=purchases, audit=audit
        )
