"""SQLite storage: library, notes, saved maps, tables and an HTTP response cache."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Iterable

from .config import data_dir

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS papers (
    id TEXT PRIMARY KEY,
    doi TEXT,
    title TEXT,
    year INTEGER,
    data TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_papers_doi ON papers(doi);

CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_papers (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    added_at REAL NOT NULL,
    status TEXT DEFAULT 'to-read',
    PRIMARY KEY (collection_id, paper_id)
);

CREATE TABLE IF NOT EXISTS notes (
    paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
    body TEXT NOT NULL DEFAULT '',
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (paper_id, tag)
);

CREATE TABLE IF NOT EXISTS maps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    seeds TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '{}',
    known TEXT NOT NULL DEFAULT '[]',
    created_at REAL NOT NULL,
    last_checked REAL
);

CREATE TABLE IF NOT EXISTS tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    columns TEXT NOT NULL,
    rows TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS fulltext (
    paper_id TEXT PRIMARY KEY,
    source_url TEXT,
    body TEXT NOT NULL,
    fetched_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS http_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS tags_updated (
    paper_id TEXT PRIMARY KEY,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    question TEXT NOT NULL,
    answer TEXT NOT NULL DEFAULT '',
    papers TEXT NOT NULL DEFAULT '[]',
    mode TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_tombstones (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    updated_at REAL NOT NULL
);
"""

# Columns added after the first release. Each is added only when missing, so older
# databases upgrade in place without losing anything.
MIGRATIONS = [
    ("collections", "uid", "TEXT"),
    ("collections", "updated_at", "REAL"),
    ("collection_papers", "updated_at", "REAL"),
    ("maps", "uid", "TEXT"),
    ("maps", "updated_at", "REAL"),
    ("tables", "uid", "TEXT"),
    ("tables", "updated_at", "REAL"),
]


class Database:
    def __init__(self, path: Path | None = None):
        self.path = path or (data_dir() / "citeweave.db")
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False, timeout=30)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._migrate()
            self._conn.commit()

    def _migrate(self) -> None:
        c = self._conn
        for table, column, kind in MIGRATIONS:
            cols = {r[1] for r in c.execute(f"PRAGMA table_info({table})").fetchall()}
            if column not in cols:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
        for table in ("collections", "maps", "tables"):
            for (rid,) in c.execute(f"SELECT id FROM {table} WHERE uid IS NULL OR uid = ''").fetchall():
                c.execute(f"UPDATE {table} SET uid=? WHERE id=?", (uuid.uuid4().hex, rid))
            c.execute(f"UPDATE {table} SET updated_at=created_at WHERE updated_at IS NULL")
            c.execute(f"CREATE UNIQUE INDEX IF NOT EXISTS idx_{table}_uid ON {table}(uid)")
        c.execute("UPDATE collection_papers SET updated_at=added_at WHERE updated_at IS NULL")
        # tags saved before sync existed have no change time; without one they would never sync
        c.execute("INSERT OR IGNORE INTO tags_updated(paper_id, updated_at) SELECT DISTINCT paper_id, ? FROM tags",
                  (time.time(),))

    # basic helpers -------------------------------------------------------
    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            cur = self._conn.execute(sql, tuple(params))
            self._conn.commit()
            return cur

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(sql, tuple(params)).fetchall()
        return [dict(r) for r in rows]

    def one(self, sql: str, params: Iterable[Any] = ()) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # cache ---------------------------------------------------------------
    def cache_get(self, key: str) -> Any | None:
        row = self.one("SELECT value, expires_at FROM http_cache WHERE key=?", (key,))
        if not row:
            return None
        if row["expires_at"] < time.time():
            self.execute("DELETE FROM http_cache WHERE key=?", (key,))
            return None
        try:
            return json.loads(row["value"])
        except json.JSONDecodeError:
            return None

    def cache_set(self, key: str, value: Any, ttl: float) -> None:
        self.execute(
            "INSERT OR REPLACE INTO http_cache(key, value, expires_at) VALUES (?,?,?)",
            (key, json.dumps(value), time.time() + ttl),
        )

    def cache_clear(self) -> int:
        cur = self.execute("DELETE FROM http_cache")
        return cur.rowcount

    def cache_prune(self) -> None:
        self.execute("DELETE FROM http_cache WHERE expires_at < ?", (time.time(),))

    # papers --------------------------------------------------------------
    # Fields the interface adds to a paper from other tables (or per search). They are not part of
    # the paper record, and storing them would show stale notes, tags or status later.
    VIEW_FIELDS = ("saved", "collections", "note", "tags", "status", "added_at", "apa", "relevance", "key_sentence")

    def upsert_paper(self, paper: dict) -> None:
        paper = {k: v for k, v in paper.items() if k not in self.VIEW_FIELDS}
        existing = self.get_paper(paper["id"])
        if existing:
            merged = {k: v for k, v in existing.items() if k not in self.VIEW_FIELDS}
            for k, v in paper.items():
                if v not in (None, "", [], {}):
                    merged[k] = v
            paper = merged
        # An upsert, not INSERT OR REPLACE: replacing would delete the row first, and the
        # foreign keys would then cascade and drop the paper from collections and notes.
        self.execute(
            """INSERT INTO papers(id, doi, title, year, data, updated_at) VALUES (?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET doi=excluded.doi, title=excluded.title, year=excluded.year,
               data=excluded.data, updated_at=excluded.updated_at""",
            (paper["id"], paper.get("doi"), paper.get("title"), paper.get("year"), json.dumps(paper), time.time()),
        )

    def get_paper(self, pid: str) -> dict | None:
        row = self.one("SELECT data FROM papers WHERE id=?", (pid,))
        return json.loads(row["data"]) if row else None


_db: Database | None = None


def db() -> Database:
    global _db
    if _db is None:
        _db = Database()
    return _db


def reset_db_for_tests(path: Path) -> Database:
    global _db
    if _db is not None:
        _db.close()
    _db = Database(path)
    return _db
