"""Preserve reading references when verified advertising pages are removed."""

from pathlib import Path
import copy, json, re


def read_manifest(root):
    file = Path(root) / "material-migrations.json"
    return (
        json.loads(file.read_text(encoding="utf-8"))
        if file.exists()
        else dict(revision="", books={})
    )


def migrate_state(value, manifest):
    revision = manifest.get("revision")
    if not revision or value.get("materialRevision") == revision:
        return value
    state = copy.deepcopy(value)
    changes = manifest.get("books", {})

    def page(identity, number):
        item = changes.get(identity)
        if not item:
            return number
        try:
            number = int(number)
        except (TypeError, ValueError):
            return number
        mapping = item["pageMap"]
        if str(number) in mapping:
            return mapping[str(number)]
        remaining = sorted(int(p) for p in mapping)
        closest = next((p for p in remaining if p >= number), remaining[-1])
        return mapping[str(closest)]

    def reference(key, drop=False):
        match = (
            re.fullmatch(r"([a-f0-9]{20}):(\d+)(.*)", key)
            if isinstance(key, str)
            else None
        )
        if not match or match[1] not in changes:
            return key
        if drop and int(match[2]) in changes[match[1]]["deletedPages"]:
            return None
        return match[1] + ":" + str(page(match[1], match[2])) + match[3]

    for identity, record in state.get("reading", {}).items():
        if identity not in changes or not isinstance(record, dict):
            continue
        if "page" in record:
            record["page"] = page(identity, record["page"])
        record["bookmarks"] = list(
            dict.fromkeys(
                page(identity, n)
                for n in record.get("bookmarks", [])
                if n not in changes[identity]["deletedPages"]
            )
        )
    for name in ["attempts", "mistakes", "questionEvents"]:
        for entry in state.get(name, []):
            if not isinstance(entry, dict):
                continue
            if entry.get("book") in changes and "page" in entry:
                entry["page"] = page(entry["book"], entry["page"])
            if isinstance(entry.get("id"), str):
                entry["id"] = reference(entry["id"])
    for name in ["notes", "conversations"]:
        result = {}
        for key, entry in state.get(name, {}).items():
            new = reference(key)
            if new in result:
                result[new] = (
                    result[new] + entry
                    if name == "conversations"
                    else str(result[new]) + "\n" + str(entry)
                )
            else:
                result[new] = entry
        if name in state:
            state[name] = result
    if "completed" in state:
        state["completed"] = list(
            dict.fromkeys(
                new
                for key in state["completed"]
                if (new := reference(key, True)) is not None
            )
        )
    for day in state.get("daily", {}).values():
        if isinstance(day, dict):
            day["pages"] = list(
                dict.fromkeys(
                    new
                    for key in day.get("pages", [])
                    if (new := reference(key, True)) is not None
                )
            )
    settings = state.get("settings", {})
    identity = settings.get("dictationBookId")
    if identity in changes:
        for entry in settings.get("dictationEntries", []):
            if isinstance(entry, dict) and entry.get("sourcePage"):
                entry["sourcePage"] = page(identity, entry["sourcePage"])
    state["materialRevision"] = revision
    return state


def apply_database_migration(db, manifest):
    revision = manifest.get("revision")
    if not revision:
        return
    marker = "material-migration:" + revision
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if conn.execute("SELECT 1 FROM kv WHERE key=?", (marker,)).fetchone():
            return
        for row in conn.execute("SELECT * FROM user_state").fetchall():
            previous = json.loads(row["value"])
            updated = migrate_state(previous, manifest)
            if previous != updated:
                conn.execute(
                    "UPDATE user_state SET value=?,revision=revision+1 WHERE user_id=?",
                    (json.dumps(updated, ensure_ascii=False), row["user_id"]),
                )
        # Clear generated metadata. Saved manual masks are reindexed or discarded
        # if they belonged exclusively to an advertisement that no longer exists.
        conn.execute("DELETE FROM kv WHERE key LIKE 'meta:%'")
        old_rules = conn.execute(
            "SELECT key,value FROM kv WHERE key LIKE 'clean:%'"
        ).fetchall()
        pending = []
        for row in old_rules:
            parts = row["key"].split(":")
            if (
                len(parts) != 3
                or parts[1] not in manifest["books"]
                or parts[2] == "all"
            ):
                continue
            conn.execute("DELETE FROM kv WHERE key=?", (row["key"],))
            mapping = manifest["books"][parts[1]]["pageMap"]
            if parts[2] in mapping:
                pending.append(
                    ("clean:" + parts[1] + ":" + str(mapping[parts[2]]), row["value"])
                )
        for key, value in pending:
            conn.execute("INSERT OR REPLACE INTO kv VALUES(?,?)", (key, value))
        conn.execute(
            "INSERT INTO kv VALUES(?,?)", (marker, json.dumps(dict(applied=True)))
        )
