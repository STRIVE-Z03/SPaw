"""Anonymous child-only practice activity board using real insight aggregates."""

from datetime import datetime, timedelta
import hashlib
import hmac
import math
import secrets
import threading
import time
from backend.learning.learning_insights import TZ

DIMENSIONS = ("math", "english", "chinese", "reading", "observation", "habit")


class LearningCommunity:
    def __init__(self, db, insights, secret=None, clock=time.time, min_questions=5):
        if type(min_questions) is not int or not 1 <= min_questions <= 50:
            raise ValueError("参与排行的最少样本数不正确")
        self.db, self.insights, self.clock, self.min_questions = (
            db,
            insights,
            clock,
            min_questions,
        )
        self.lock = threading.RLock()
        self.cache = None
        if secret is None:
            with self.db() as conn:
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS learning_community_config(key TEXT PRIMARY KEY,value TEXT NOT NULL)"
                )
                conn.execute(
                    "INSERT OR IGNORE INTO learning_community_config VALUES(?,?)",
                    ("alias_salt", secrets.token_hex(32)),
                )
                stored = conn.execute(
                    "SELECT value FROM learning_community_config WHERE key=?",
                    ("alias_salt",),
                ).fetchone()[0]
            try:
                secret = bytes.fromhex(stored)
            except (ValueError, TypeError):
                raise ValueError("排行榜匿名配置不可用") from None
        if isinstance(secret, str):
            secret = secret.encode()
        if not isinstance(secret, bytes) or len(secret) < 32:
            raise ValueError("排行榜匿名配置需要至少32字节")
        self.secret = secret

    def _enabled(self):
        with self.db() as conn:
            # Deliberately do not select usernames, child names or family links.
            return {
                int(row[0])
                for row in conn.execute(
                    "SELECT id FROM users WHERE role='child' AND enabled=1"
                )
            }

    def _identity(self, uid):
        month = datetime.fromtimestamp(self.clock(), TZ).strftime("%Y-%m")
        value = hmac.new(
            self.secret,
            ("child-alias:" + month + ":" + str(uid)).encode(),
            hashlib.sha256,
        ).hexdigest()
        return value[:24], "小爪" + value[:8].upper()

    def _dimensions(self, snapshot):
        result = {}
        minimum = max(3, getattr(self.insights, "min_samples", 5))
        for name in DIMENSIONS:
            item = (snapshot.get("dimensions") or {}).get(name, {})
            samples = item.get("samples", 0)
            samples = samples if type(samples) is int and samples >= 0 else 0
            value = item.get("value")
            valid = (
                not isinstance(value, bool)
                and isinstance(value, (int, float))
                and math.isfinite(value)
                and 0 <= value <= 100
                and samples >= minimum
                and item.get("sufficient") is True
            )
            # There is no habit assessment in the current data model. Activity
            # counts must not be relabeled as a precise ability score.
            result[name] = dict(
                value=round(value, 1) if valid and name != "habit" else None,
                samples=samples,
                sufficient=valid and name != "habit",
            )
        return result

    def _build(self, enabled):
        snapshots = {}
        for uid in sorted(enabled):
            try:
                value = self.insights.community_snapshot(uid, days=30)
                count = value.get("uniqueQuestions")
                if type(count) is not int or count < 0:
                    continue
                snapshots[uid] = dict(
                    uniqueQuestions=count, dimensions=self._dimensions(value)
                )
            except Exception:
                # An unavailable account is omitted, never represented as a
                # zero score. No private error text crosses this boundary.
                continue
        return snapshots

    def summary(self, uid, limit=50, force=False):
        uid = self.insights.uid(uid)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("排行榜展示数量不正确")
        enabled = self._enabled()
        if uid not in enabled:
            raise PermissionError(
                "排行榜仅向启用中的宝宝账号开放；家长可查看自家宝宝的学习洞察"
            )
        today = datetime.fromtimestamp(self.clock(), TZ).date()
        with self.lock:
            now = self.clock()
            if (
                force
                or self.cache is None
                or now - self.cache["at"] >= 15
                or self.cache["date"] != today
                or enabled != self.cache["enabled"]
            ):
                self.cache = dict(
                    at=now, date=today, enabled=enabled, snapshots=self._build(enabled)
                )
            snapshots = self.cache["snapshots"]
        # Revalidate after aggregation too, so a concurrent account disable is
        # reflected immediately rather than after the cache expires.
        enabled = self._enabled()
        if uid not in enabled:
            raise PermissionError("当前宝宝账号未启用")
        ranked = []
        for identity, value in snapshots.items():
            if identity not in enabled or value["uniqueQuestions"] < self.min_questions:
                continue
            opaque, alias = self._identity(identity)
            ranked.append(
                dict(
                    id=opaque,
                    alias=alias,
                    uniqueQuestions=value["uniqueQuestions"],
                    dimensions=value["dimensions"],
                    isSelf=identity == uid,
                )
            )
        ranked.sort(key=lambda row: (-row["uniqueQuestions"], row["id"]))
        previous = None
        rank = 0
        for index, row in enumerate(ranked):
            if row["uniqueQuestions"] != previous:
                rank = index + 1
            row["rank"] = rank
            previous = row["uniqueQuestions"]
        own = next((row for row in ranked if row["isSelf"]), None)
        if own is None:
            value = snapshots.get(uid)
            opaque, alias = self._identity(uid)
            own = dict(
                id=opaque,
                alias=alias,
                isSelf=True,
                rank=None,
                uniqueQuestions=value["uniqueQuestions"] if value else None,
                dimensions=value["dimensions"]
                if value
                else {
                    name: dict(value=None, samples=0, sufficient=False)
                    for name in DIMENSIONS
                },
            )
        own = {
            **own,
            "available": uid in snapshots,
            "eligible": own["rank"] is not None,
        }
        return dict(
            schema="banxuepaw-learning-community-v1",
            title="爪爪排行榜",
            period=dict(
                days=30,
                fromDate=(today - timedelta(days=29)).isoformat(),
                toDate=today.isoformat(),
                timezone="Asia/Shanghai",
            ),
            metric=dict(
                id="unique-checked-questions", label="已核对独立题数", unit="题"
            ),
            participants=len(ranked),
            rows=ranked[:limit],
            self=own,
            policy=dict(
                minQuestions=self.min_questions,
                minDimensionSamples=max(3, getattr(self.insights, "min_samples", 5)),
                note="按近30天已核对的独立题数排序，同一道题重复核对不增加。只展示启用中的宝宝账号，其他孩子使用匿名别名。",
                radarNote="六维仅展示对应已核对样本的一致率；样本不足留空，不代表完整能力。学习习惯暂无对应测评。",
            ),
        )

    def board(self, uid, limit=50, force=False):
        return self.summary(uid, limit, force)
