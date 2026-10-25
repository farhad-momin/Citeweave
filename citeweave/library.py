"""Your local library: collections, reading status, notes, tags, saved maps, tables and
question history.

Every change records when it happened, and every deletion leaves a small marker
(a tombstone), so that sync can tell which copy of an item is newer on each device.
Times here are seconds; the sync file uses milliseconds (see sync.py).
"""
from __future__ import annotations

import json
import time
import uuid

from .db import db

STATUSES = ("to-read", "reading", "read", "skip")


def now() -> float:
    return time.time()


def new_uid() -> str:
    return uuid.uuid4().hex


def tombstone(key: str, kind: str, at: float | None = None) -> None:
    db().execute("INSERT OR REPLACE INTO sync_tombstones(key, kind, updated_at) VALUES (?,?,?)",
                 (key, kind, at if at is not None else now()))


def clear_tombstone(key: str) -> None:
    db().execute("DELETE FROM sync_tombstones WHERE key=?", (key,))


def collection_uid(cid: int) -> str | None:
    row = db().one("SELECT uid FROM collections WHERE id=?", (cid,))
    return row["uid"] if row else None


# collections ---------------------------------------------------------------
def list_collections() -> list[dict]:
    return db().query("""
        SELECT c.id, c.uid, c.name, c.description, c.created_at, c.updated_at, COUNT(cp.paper_id) AS count
        FROM collections c LEFT JOIN collection_papers cp ON cp.collection_id = c.id
        GROUP BY c.id ORDER BY c.name COLLATE NOCASE""")


def create_collection(name: str, description: str = "", *, uid: str | None = None,
                      created_at: float | None = None, updated_at: float | None = None) -> dict:
    name = (name or "").strip() or "Untitled collection"
    uid = uid or new_uid()
    t = now()
    cur = db().execute(
        "INSERT INTO collections(name, description, created_at, uid, updated_at) VALUES (?,?,?,?,?)",
        (name, description or "", created_at or t, uid, updated_at or t))
    clear_tombstone(f"collection:{uid}")
    return {"id": cur.lastrowid, "uid": uid, "name": name, "description": description or "", "count": 0}


def find_collection(ref) -> dict | None:
    """Find a collection by id, uid or name (case-insensitive)."""
    s = str(ref or "").strip()
    if not s:
        return None
    if s.isdigit():
        row = db().one("SELECT * FROM collections WHERE id=?", (int(s),))
        if row:
            return row
    return (db().one("SELECT * FROM collections WHERE uid=?", (s,))
            or db().one("SELECT * FROM collections WHERE name=? COLLATE NOCASE", (s,)))


DEFAULT_COLLECTION_UID = "reading-list"


def ensure_default() -> int:
    row = db().one("SELECT id FROM collections ORDER BY id LIMIT 1")
    if row:
        return row["id"]
    # Same id on every device, so syncing never creates a second reading list.
    return create_collection("My reading list", uid=DEFAULT_COLLECTION_UID)["id"]


def rename_collection(cid: int, name: str, description: str | None = None) -> None:
    if description is None:
        db().execute("UPDATE collections SET name=?, updated_at=? WHERE id=?", (name.strip(), now(), cid))
    else:
        db().execute("UPDATE collections SET name=?, description=?, updated_at=? WHERE id=?",
                     (name.strip(), description, now(), cid))


def delete_collection(cid: int, at: float | None = None) -> None:
    uid = collection_uid(cid)
    if uid:
        t = at if at is not None else now()
        for r in db().query("SELECT paper_id FROM collection_papers WHERE collection_id=?", (cid,)):
            tombstone(f"member:{uid}|{r['paper_id']}", "member", t)
        tombstone(f"collection:{uid}", "collection", t)
    db().execute("DELETE FROM collections WHERE id=?", (cid,))


# members -------------------------------------------------------------------
def add_papers(cid: int, papers: list[dict]) -> int:
    n = 0
    uid = collection_uid(cid)
    for p in papers:
        db().upsert_paper(p)
        t = now()
        cur = db().execute(
            "INSERT OR IGNORE INTO collection_papers(collection_id, paper_id, added_at, updated_at) VALUES (?,?,?,?)",
            (cid, p["id"], t, t))
        if cur.rowcount and uid:
            clear_tombstone(f"member:{uid}|{p['id']}")
        n += cur.rowcount
    return n


def remove_paper(cid: int, pid: str, at: float | None = None) -> None:
    uid = collection_uid(cid)
    cur = db().execute("DELETE FROM collection_papers WHERE collection_id=? AND paper_id=?", (cid, pid))
    if uid and cur.rowcount:
        tombstone(f"member:{uid}|{pid}", "member", at)


def set_status(cid: int, pid: str, status: str) -> None:
    if status not in STATUSES:
        raise ValueError(f"status must be one of {STATUSES}")
    db().execute("UPDATE collection_papers SET status=?, updated_at=? WHERE collection_id=? AND paper_id=?",
                 (status, now(), cid, pid))


def collection_papers(cid: int) -> list[dict]:
    rows = db().query("""
        SELECT p.data, cp.status, cp.added_at, n.body AS note
        FROM collection_papers cp JOIN papers p ON p.id = cp.paper_id
        LEFT JOIN notes n ON n.paper_id = p.id
        WHERE cp.collection_id=? ORDER BY cp.added_at DESC""", (cid,))
    out = []
    tags = tag_map()
    for r in rows:
        p = json.loads(r["data"])
        p["status"] = r["status"]
        p["added_at"] = r["added_at"]
        p["note"] = r["note"] or ""
        p["tags"] = tags.get(p["id"], [])
        out.append(p)
    return out


def all_papers() -> list[dict]:
    rows = db().query("SELECT DISTINCT p.data FROM papers p JOIN collection_papers cp ON cp.paper_id = p.id")
    return [json.loads(r["data"]) for r in rows]


def paper_memberships(pid: str) -> list[int]:
    return [r["collection_id"] for r in db().query(
        "SELECT collection_id FROM collection_papers WHERE paper_id=?", (pid,))]


def saved_ids() -> list[str]:
    return [r["paper_id"] for r in db().query("SELECT DISTINCT paper_id FROM collection_papers")]


# notes and tags --------------------------------------------------------------
def get_note(pid: str) -> str:
    row = db().one("SELECT body FROM notes WHERE paper_id=?", (pid,))
    return row["body"] if row else ""


def set_note(pid: str, body: str, at: float | None = None) -> None:
    if not db().get_paper(pid):
        raise KeyError("Save the paper to a collection before adding notes")
    db().execute("INSERT OR REPLACE INTO notes(paper_id, body, updated_at) VALUES (?,?,?)",
                 (pid, body, at if at is not None else now()))
    clear_tombstone(f"note:{pid}")


def tag_map() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for r in db().query("SELECT paper_id, tag FROM tags ORDER BY tag"):
        out.setdefault(r["paper_id"], []).append(r["tag"])
    return out


def set_tags(pid: str, tags: list[str], at: float | None = None) -> None:
    db().execute("DELETE FROM tags WHERE paper_id=?", (pid,))
    for t in dict.fromkeys(t.strip() for t in tags if t and t.strip()):
        db().execute("INSERT OR IGNORE INTO tags(paper_id, tag) VALUES (?,?)", (pid, t[:60]))
    db().execute("INSERT OR REPLACE INTO tags_updated(paper_id, updated_at) VALUES (?,?)",
                 (pid, at if at is not None else now()))
    clear_tombstone(f"tags:{pid}")


# saved maps ---------------------------------------------------------------
def list_maps() -> list[dict]:
    rows = db().query(
        "SELECT id, uid, name, seeds, options, created_at, last_checked, updated_at FROM maps ORDER BY created_at DESC")
    for r in rows:
        r["seeds"] = json.loads(r["seeds"])
        r["options"] = json.loads(r["options"])
    return rows


def save_map(name: str, seeds: list[dict], options: dict, known: list[str], map_id: int | None = None) -> int:
    seeds_j = json.dumps(seeds)
    t = now()
    if map_id:
        db().execute("UPDATE maps SET name=?, seeds=?, options=?, known=?, updated_at=? WHERE id=?",
                     (name, seeds_j, json.dumps(options), json.dumps(known), t, map_id))
        return map_id
    cur = db().execute(
        "INSERT INTO maps(name, seeds, options, known, created_at, last_checked, uid, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        (name, seeds_j, json.dumps(options), json.dumps(known), t, t, new_uid(), t))
    return cur.lastrowid


def get_map(map_id: int) -> dict | None:
    r = db().one("SELECT * FROM maps WHERE id=?", (map_id,))
    if not r:
        return None
    for k in ("seeds", "options", "known"):
        r[k] = json.loads(r[k])
    return r


def touch_map(map_id: int, known: list[str]) -> None:
    t = now()
    db().execute("UPDATE maps SET last_checked=?, known=?, updated_at=? WHERE id=?", (t, json.dumps(known), t, map_id))


def delete_map(map_id: int, at: float | None = None) -> None:
    row = db().one("SELECT uid FROM maps WHERE id=?", (map_id,))
    if row and row["uid"]:
        tombstone(f"map:{row['uid']}", "map", at)
    db().execute("DELETE FROM maps WHERE id=?", (map_id,))


# saved tables -------------------------------------------------------------
def list_tables() -> list[dict]:
    rows = db().query("SELECT id, uid, name, columns, rows, created_at, updated_at FROM tables ORDER BY created_at DESC")
    for r in rows:
        r["columns"] = json.loads(r["columns"])
        r["rows"] = json.loads(r["rows"])
    return rows


def save_table(name: str, columns: list[dict], rows: list[dict], table_id: int | None = None) -> int:
    t = now()
    if table_id:
        db().execute("UPDATE tables SET name=?, columns=?, rows=?, updated_at=? WHERE id=?",
                     (name, json.dumps(columns), json.dumps(rows), t, table_id))
        return table_id
    cur = db().execute("INSERT INTO tables(name, columns, rows, created_at, uid, updated_at) VALUES (?,?,?,?,?,?)",
                       (name, json.dumps(columns), json.dumps(rows), t, new_uid(), t))
    return cur.lastrowid


def delete_table(table_id: int, at: float | None = None) -> None:
    row = db().one("SELECT uid FROM tables WHERE id=?", (table_id,))
    if row and row["uid"]:
        tombstone(f"table:{row['uid']}", "table", at)
    db().execute("DELETE FROM tables WHERE id=?", (table_id,))


# question history ---------------------------------------------------------------
def _history_row(r: dict) -> dict:
    r = dict(r)
    try:
        r["papers"] = json.loads(r.get("papers") or "[]")
    except json.JSONDecodeError:
        r["papers"] = []
    return r


def list_history(limit: int = 500) -> list[dict]:
    rows = db().query("SELECT * FROM history ORDER BY created_at DESC LIMIT ?", (limit,))
    return [_history_row(r) for r in rows]


def add_history(question: str, answer: str, papers: list | None = None, mode: str = "", *,
                uid: str | None = None, created_at: float | None = None, updated_at: float | None = None) -> dict:
    question = (question or "").strip()
    if not question:
        raise ValueError("A question is required")
    uid = uid or new_uid()
    t = now()
    cur = db().execute(
        "INSERT OR REPLACE INTO history(uid, question, answer, papers, mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        (uid, question, answer or "", json.dumps(papers or []), mode or "", created_at or t, updated_at or t))
    clear_tombstone(f"history:{uid}")
    return _history_row(db().one("SELECT * FROM history WHERE id=?", (cur.lastrowid,)))


def delete_history(hid: int, at: float | None = None) -> bool:
    row = db().one("SELECT uid FROM history WHERE id=?", (hid,))
    if not row:
        return False
    tombstone(f"history:{row['uid']}", "history", at)
    db().execute("DELETE FROM history WHERE id=?", (hid,))
    return True
