"""Deterministic public-domain daily readings and per-child Beijing-day welcome."""

from datetime import datetime, timedelta, timezone
import time

QUOTES = [
    ("学而时习之，不亦说乎？", "《论语·学而》", "把今天学会的一点，再试一遍。"),
    ("温故而知新，可以为师矣。", "《论语·为政》", "再看一遍旧知识，也会发现新线索。"),
    (
        "知之为知之，不知为不知，是知也。",
        "《论语·为政》",
        "没明白也没关系，说出来，一起弄清楚。",
    ),
    ("学而不思则罔，思而不学则殆。", "《论语·为政》", "学一学，也停下来想一想。"),
    ("千里之行，始于足下。", "《老子》第六十四章", "先把眼前的一个小步骤做好。"),
    ("不积跬步，无以至千里。", "荀子《劝学》", "每天的一点练习，都会慢慢积累。"),
    ("欲穷千里目，更上一层楼。", "王之涣《登鹳雀楼》", "往前试一步，也许就看懂了。"),
    (
        "纸上得来终觉浅，绝知此事要躬行。",
        "陆游《冬夜读书示子聿》",
        "读懂以后，亲手试一试。",
    ),
    (
        "问渠那得清如许？为有源头活水来。",
        "朱熹《观书有感》",
        "一个好问题，就是新发现的开始。",
    ),
    (
        "读书破万卷，下笔如有神。",
        "杜甫《奉赠韦左丞丈二十二韵》",
        "把读到的好词好句，慢慢用起来。",
    ),
    (
        "黑发不知勤学早，白首方悔读书迟。",
        "颜真卿《劝学》",
        "今天留一点时间，给好奇的自己。",
    ),
    (
        "博学之，审问之，慎思之，明辨之，笃行之。",
        "《礼记·中庸》",
        "遇到问题，看看条件，再动手试试。",
    ),
]


class DailyLearning:
    def __init__(self, db, clock=time.time):
        self.db, self.clock = db, clock

    def _date(self):
        return datetime.fromtimestamp(self.clock(), timezone(timedelta(hours=8))).date()

    def get(self, uid):
        day = self._date()
        text, source, meaning = QUOTES[day.toordinal() % len(QUOTES)]
        with self.db() as conn:
            seen = bool(
                conn.execute(
                    "SELECT 1 FROM kv WHERE key=?",
                    ("welcome:" + str(uid) + ":" + str(day),),
                ).fetchone()
            )
        return dict(
            date=str(day),
            timezone="Asia/Shanghai",
            quote=dict(text=text, source=source, meaning=meaning),
            welcomeSeen=seen,
        )

    def welcome(self, uid):
        day = self._date()
        key = "welcome:" + str(uid) + ":" + str(day)
        with self.db() as conn:
            created = (
                conn.execute(
                    "INSERT OR IGNORE INTO kv(key,value) VALUES(?,?)", (key, "1")
                ).rowcount
                == 1
            )
            # Only daily welcome flags expire here; no learning record is removed.
            conn.execute(
                "DELETE FROM kv WHERE key LIKE 'welcome:%' AND substr(key,-10)<?",
                (str(day - timedelta(days=35)),),
            )
        return dict(show=created, date=str(day))
