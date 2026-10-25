"""Sync file shared by the PC app and the web version (format in web/SPEC.md).

export_document() turns the local library into one JSON document. import_document()
applies every record in a document that is newer than the local copy, including
deletions. Merging two documents and encrypting them is done by the interface
(static/engine/sync.js); this module only reads and writes plain documents, and moves
files to and from a sync folder or a GitHub repository.
"""
from __future__ import annotations

import base64
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

from . import library
from .config import data_dir, settings
from .db import db

FORMAT = "citeweave-sync"
ENCRYPTED_FORMAT = "citeweave-sync-encrypted"
VERSION = 1
FILE_NAME = "citeweave-sync.json"
TOMBSTONE_DAYS = 180

# collections must exist before the members that point at them
KIND_ORDER = {"collection": 0, "member": 1, "note": 2, "tags": 3, "map": 4, "table": 5, "history": 6}


class SyncError(Exception):
    """Shown to the user as is."""


def ms(t: float | None) -> int:
    return int(round((t or 0) * 1000))


def sec(m: Any) -> float:
    try:
        return float(m) / 1000.0
    except (TypeError, ValueError):
        return 0.0


def device_id() -> str:
    path = data_dir() / "device-id"
    try:
        v = path.read_text(encoding="utf-8").strip()
        if v:
            return v
    except OSError:
        pass
    v = "desktop-" + uuid.uuid4().hex[:8]
    try:
        path.write_text(v, encoding="utf-8")
    except OSError:
        pass
    return v


def _rec(kind: str, rid: str, updated: float, data: dict) -> tuple[str, dict]:
    key = f"{kind}:{rid}"
    return key, {"kind": kind, "id": rid, "updated_at": ms(updated), "deleted": False, "data": data}


def _loads(s: str | None, default: Any) -> Any:
    try:
        return json.loads(s) if s else default
    except json.JSONDecodeError:
        return default


def _ids_in(items: Any) -> list[str]:
    out = []
    for x in items or []:
        if isinstance(x, dict) and x.get("id"):
            out.append(str(x["id"]))
        elif isinstance(x, str):
            out.append(x)
    return out


# export ------------------------------------------------------------------------------
def export_document() -> dict:
    d = db()
    records: dict[str, dict] = {}
    paper_ids: set[str] = set()

    cols = d.query("SELECT id, uid, name, description, created_at, updated_at FROM collections")
    uid_of = {c["id"]: c["uid"] for c in cols}
    for c in cols:
        k, r = _rec("collection", c["uid"], c["updated_at"] or c["created_at"],
                    {"name": c["name"], "description": c["description"] or "", "created_at": ms(c["created_at"])})
        records[k] = r

    for m in d.query("SELECT collection_id, paper_id, added_at, status, updated_at FROM collection_papers"):
        cu = uid_of.get(m["collection_id"])
        if not cu:
            continue
        k, r = _rec("member", f"{cu}|{m['paper_id']}", m["updated_at"] or m["added_at"],
                    {"collection": cu, "paper_id": m["paper_id"], "status": m["status"] or "to-read",
                     "added_at": ms(m["added_at"])})
        records[k] = r
        paper_ids.add(m["paper_id"])

    for n in d.query("SELECT paper_id, body, updated_at FROM notes"):
        k, r = _rec("note", n["paper_id"], n["updated_at"], {"paper_id": n["paper_id"], "body": n["body"] or ""})
        records[k] = r
        paper_ids.add(n["paper_id"])

    tags = library.tag_map()
    tag_times = {r["paper_id"]: r["updated_at"] for r in d.query("SELECT paper_id, updated_at FROM tags_updated")}
    for pid in set(tags) | set(tag_times):
        k, r = _rec("tags", pid, tag_times.get(pid, 0), {"paper_id": pid, "tags": tags.get(pid, [])})
        records[k] = r
        paper_ids.add(pid)

    for m in d.query("SELECT * FROM maps"):
        seeds = _loads(m["seeds"], [])
        k, r = _rec("map", m["uid"], m["updated_at"] or m["created_at"], {
            "name": m["name"], "seeds": seeds, "options": _loads(m["options"], {}), "known": _loads(m["known"], []),
            "last_checked": ms(m["last_checked"]), "created_at": ms(m["created_at"])})
        records[k] = r
        paper_ids.update(_ids_in(seeds))

    for t in d.query("SELECT * FROM tables"):
        rows = _loads(t["rows"], [])
        pids = [str(x.get("paper_id")) for x in rows if isinstance(x, dict) and x.get("paper_id")]
        k, r = _rec("table", t["uid"], t["updated_at"] or t["created_at"], {
            "name": t["name"], "columns": _loads(t["columns"], []), "rows": rows, "paper_ids": pids,
            "created_at": ms(t["created_at"])})
        records[k] = r
        paper_ids.update(pids)

    for h in d.query("SELECT * FROM history"):
        papers = _loads(h["papers"], [])
        k, r = _rec("history", h["uid"], h["updated_at"], {
            "question": h["question"], "answer": h["answer"], "papers": papers, "mode": h["mode"] or "",
            "created_at": ms(h["created_at"])})
        records[k] = r
        paper_ids.update(_ids_in(papers))

    cutoff = time.time() - TOMBSTONE_DAYS * 86400
    d.execute("DELETE FROM sync_tombstones WHERE updated_at < ?", (cutoff,))
    for t in d.query("SELECT key, kind, updated_at FROM sync_tombstones"):
        if t["key"] in records:
            continue
        rid = t["key"].split(":", 1)[1] if ":" in t["key"] else t["key"]
        records[t["key"]] = {"kind": t["kind"], "id": rid, "updated_at": ms(t["updated_at"]), "deleted": True, "data": {}}

    papers: dict[str, dict] = {}
    for pid in paper_ids:
        p = d.get_paper(pid)
        if p:
            papers[pid] = p
    newest = max([r["updated_at"] for r in records.values()] or [0])
    return {"format": FORMAT, "version": VERSION, "updated_at": newest or ms(time.time()),
            "device": device_id(), "records": records, "papers": papers}


# import ------------------------------------------------------------------------------
def _local_version(kind: str, rid: str) -> float:
    """Seconds since 1970 of the local copy (row or tombstone), 0 if none."""
    d = db()
    row = None
    if kind == "collection":
        row = d.one("SELECT updated_at FROM collections WHERE uid=?", (rid,))
    elif kind == "member":
        cu, _, pid = rid.partition("|")
        row = d.one("""SELECT cp.updated_at FROM collection_papers cp JOIN collections c ON c.id = cp.collection_id
                       WHERE c.uid=? AND cp.paper_id=?""", (cu, pid))
    elif kind == "note":
        row = d.one("SELECT updated_at FROM notes WHERE paper_id=?", (rid,))
    elif kind == "tags":
        row = d.one("SELECT updated_at FROM tags_updated WHERE paper_id=?", (rid,))
    elif kind in ("map", "table", "history"):
        table = {"map": "maps", "table": "tables", "history": "history"}[kind]
        row = d.one(f"SELECT updated_at FROM {table} WHERE uid=?", (rid,))
    tomb = d.one("SELECT updated_at FROM sync_tombstones WHERE key=?", (f"{kind}:{rid}",))
    return max((row or {}).get("updated_at") or 0, (tomb or {}).get("updated_at") or 0)


def _delete(kind: str, rid: str, at: float) -> None:
    d = db()
    if kind == "collection":
        c = d.one("SELECT id FROM collections WHERE uid=?", (rid,))
        if c:
            library.delete_collection(c["id"], at=at)
    elif kind == "member":
        cu, _, pid = rid.partition("|")
        c = d.one("SELECT id FROM collections WHERE uid=?", (cu,))
        if c:
            d.execute("DELETE FROM collection_papers WHERE collection_id=? AND paper_id=?", (c["id"], pid))
    elif kind == "note":
        d.execute("DELETE FROM notes WHERE paper_id=?", (rid,))
    elif kind == "tags":
        d.execute("DELETE FROM tags WHERE paper_id=?", (rid,))
        d.execute("DELETE FROM tags_updated WHERE paper_id=?", (rid,))
    elif kind in ("map", "table", "history"):
        table = {"map": "maps", "table": "tables", "history": "history"}[kind]
        d.execute(f"DELETE FROM {table} WHERE uid=?", (rid,))
    library.tombstone(f"{kind}:{rid}", kind, at)


def _apply(kind: str, rid: str, at: float, data: dict) -> bool:
    """Create or update one record locally. Returns False when it cannot be applied yet."""
    d = db()
    if kind == "collection":
        c = d.one("SELECT id FROM collections WHERE uid=?", (rid,))
        if c:
            d.execute("UPDATE collections SET name=?, description=?, updated_at=? WHERE id=?",
                      (data.get("name") or "Untitled collection", data.get("description") or "", at, c["id"]))
        else:
            library.create_collection(data.get("name") or "", data.get("description") or "", uid=rid,
                                      created_at=sec(data.get("created_at")) or at, updated_at=at)
    elif kind == "member":
        cu = data.get("collection") or rid.partition("|")[0]
        pid = data.get("paper_id") or rid.partition("|")[2]
        c = d.one("SELECT id FROM collections WHERE uid=?", (cu,))
        if not c or not d.get_paper(pid):
            return False
        status = data.get("status") if data.get("status") in library.STATUSES else "to-read"
        d.execute("""INSERT INTO collection_papers(collection_id, paper_id, added_at, status, updated_at)
                     VALUES (?,?,?,?,?)
                     ON CONFLICT(collection_id, paper_id) DO UPDATE SET status=excluded.status,
                     updated_at=excluded.updated_at""",
                  (c["id"], pid, sec(data.get("added_at")) or at, status, at))
    elif kind == "note":
        pid = data.get("paper_id") or rid
        if not d.get_paper(pid):
            return False
        d.execute("INSERT OR REPLACE INTO notes(paper_id, body, updated_at) VALUES (?,?,?)",
                  (pid, data.get("body") or "", at))
    elif kind == "tags":
        pid = data.get("paper_id") or rid
        if not d.get_paper(pid):
            return False
        library.set_tags(pid, [str(t) for t in data.get("tags") or []], at=at)
    elif kind == "map":
        m = d.one("SELECT id FROM maps WHERE uid=?", (rid,))
        vals = (data.get("name") or "Untitled map", json.dumps(data.get("seeds") or []),
                json.dumps(data.get("options") or {}), json.dumps(data.get("known") or []),
                sec(data.get("last_checked")) or None, at)
        if m:
            d.execute("UPDATE maps SET name=?, seeds=?, options=?, known=?, last_checked=?, updated_at=? WHERE id=?",
                      (*vals, m["id"]))
        else:
            d.execute("""INSERT INTO maps(name, seeds, options, known, last_checked, updated_at, created_at, uid)
                         VALUES (?,?,?,?,?,?,?,?)""", (*vals, sec(data.get("created_at")) or at, rid))
    elif kind == "table":
        t = d.one("SELECT id FROM tables WHERE uid=?", (rid,))
        vals = (data.get("name") or "Untitled table", json.dumps(data.get("columns") or []),
                json.dumps(data.get("rows") or []), at)
        if t:
            d.execute("UPDATE tables SET name=?, columns=?, rows=?, updated_at=? WHERE id=?", (*vals, t["id"]))
        else:
            d.execute("INSERT INTO tables(name, columns, rows, updated_at, created_at, uid) VALUES (?,?,?,?,?,?)",
                      (*vals, sec(data.get("created_at")) or at, rid))
    elif kind == "history":
        h = d.one("SELECT id FROM history WHERE uid=?", (rid,))
        if h:
            d.execute("UPDATE history SET question=?, answer=?, papers=?, mode=?, updated_at=? WHERE id=?",
                      (data.get("question") or "", data.get("answer") or "", json.dumps(data.get("papers") or []),
                       data.get("mode") or "", at, h["id"]))
        else:
            if not (data.get("question") or "").strip():
                return False
            library.add_history(data.get("question"), data.get("answer") or "", data.get("papers") or [],
                                data.get("mode") or "", uid=rid, created_at=sec(data.get("created_at")) or at,
                                updated_at=at)
    else:
        return False
    library.clear_tombstone(f"{kind}:{rid}")
    return True


def import_document(doc: dict) -> dict:
    if not isinstance(doc, dict):
        raise SyncError("The sync file is not valid.")
    if doc.get("format") == ENCRYPTED_FORMAT:
        raise SyncError("This sync file is encrypted. Unlock it with your sync passphrase first.")
    if doc.get("format") != FORMAT:
        raise SyncError("This is not a Citeweave sync file.")
    try:
        version = int(doc.get("version") or 0)
    except (TypeError, ValueError):
        raise SyncError("This is not a Citeweave sync file.") from None
    if version > VERSION:
        raise SyncError("This sync file was made by a newer Citeweave. Please update the app.")

    for pid, p in (doc.get("papers") or {}).items():
        if isinstance(p, dict) and p.get("title") is not None:
            p = {**p, "id": p.get("id") or pid}
            db().upsert_paper(p)

    applied = skipped = 0
    items = []
    for key, r in (doc.get("records") or {}).items():
        if not isinstance(r, dict):
            continue
        kind = r.get("kind") or key.split(":", 1)[0]
        rid = r.get("id") or (key.split(":", 1)[1] if ":" in key else "")
        if kind not in KIND_ORDER or not rid:
            skipped += 1
            continue
        items.append((KIND_ORDER[kind], kind, rid, r))
    items.sort(key=lambda x: x[0])

    for _, kind, rid, r in items:
        incoming = sec(r.get("updated_at"))
        if incoming <= _local_version(kind, rid) + 1e-6:
            skipped += 1
            continue
        if r.get("deleted"):
            _delete(kind, rid, incoming)
            applied += 1
        elif _apply(kind, rid, incoming, r.get("data") or {}):
            applied += 1
        else:
            skipped += 1
    return {"applied": applied, "skipped": skipped}


# sync folder -------------------------------------------------------------------------
def folder_path() -> Path:
    folder = (settings().get("sync", "folder") or "").strip()
    if not folder:
        raise SyncError("Choose a sync folder first.")
    p = Path(os.path.expandvars(os.path.expanduser(folder)))
    if not p.is_dir():
        raise SyncError(f"The sync folder was not found: {folder}")
    return p


def read_folder() -> dict:
    p = folder_path()
    f = p / FILE_NAME
    out: dict[str, Any] = {"path": str(f), "exists": f.exists()}
    if f.exists():
        try:
            out["document"] = json.loads(f.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as e:
            raise SyncError(f"Could not read {f.name}: {e}") from e
    return out


def write_folder(document: dict) -> dict:
    if not isinstance(document, dict) or document.get("format") not in (FORMAT, ENCRYPTED_FORMAT):
        raise SyncError("Nothing to write: the document is not a Citeweave sync file.")
    p = folder_path()
    f = p / FILE_NAME
    tmp = p / (FILE_NAME + ".tmp")
    try:
        tmp.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, f)
    except OSError as e:  # e.g. a cloud drive app holding the file open on Windows
        raise SyncError(f"Could not write {f.name} in the sync folder: {e}. Try again in a moment.") from e
    return {"path": str(f), "bytes": f.stat().st_size}


# GitHub -----------------------------------------------------------------------------
GITHUB_API = "https://api.github.com"


def _github_cfg() -> dict:
    g = settings().get("sync", "github", default={}) or {}
    token = (g.get("token") or "").strip()
    repo = (g.get("repo") or "").strip().removeprefix("https://github.com/").strip("/")
    path = (g.get("path") or FILE_NAME).strip().lstrip("/")
    branch = (g.get("branch") or "main").strip()
    if not token:
        raise SyncError("Add a GitHub token in Settings, Sync.")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        raise SyncError("Enter the repository as owner/name, for example farhad/citeweave-data.")
    if ".." in path.split("/") or not path:
        raise SyncError("The file path in the repository is not valid.")
    return {"token": token, "repo": repo, "path": path, "branch": branch}


def _github_error(resp, cfg: dict) -> SyncError:
    if resp.status_code == 401:
        return SyncError("GitHub did not accept the token. Create a new one and paste it in Settings, Sync.")
    if resp.status_code == 403:
        return SyncError("The GitHub token cannot write to this repository. Give it Contents: read and write.")
    if resp.status_code == 404:
        return SyncError(f"Repository {cfg['repo']} or branch {cfg['branch']} was not found, "
                         "or the token cannot see it.")
    if resp.status_code in (409, 422):
        return SyncError("The sync file changed on GitHub while saving. Sync again.")
    return SyncError(f"GitHub answered {resp.status_code}: {resp.text[:200]}")


# sha of the GitHub file as last read, per (repo, branch, path). A write goes over that exact
# version, so a change another device saved in between makes GitHub refuse (409) instead of
# being overwritten. Mirrors web/engine/router.js.
_github_sha: dict[tuple, str | None] = {}


async def github(action: str, document: dict | None = None, sha: str | None = None) -> dict:
    from .net import client

    cfg = _github_cfg()
    headers = {"Authorization": f"Bearer {cfg['token']}", "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    url = f"{GITHUB_API}/repos/{cfg['repo']}/contents/{cfg['path']}"
    memo = (cfg["repo"], cfg["branch"], cfg["path"])
    http = client()

    async def read() -> dict:
        resp = await http.get(url, params={"ref": cfg["branch"]}, headers=headers)
        if resp.status_code == 404:
            # tell "no file yet" apart from "no repository"
            repo = await http.get(f"{GITHUB_API}/repos/{cfg['repo']}", headers=headers)
            if repo.status_code == 200:
                _github_sha[memo] = None
                return {"document": None, "sha": None}
            raise _github_error(repo, cfg)
        if resp.status_code != 200:
            raise _github_error(resp, cfg)
        meta = resp.json()
        content = meta.get("content") or ""
        if not content and meta.get("size"):
            blob = await http.get(f"{GITHUB_API}/repos/{cfg['repo']}/git/blobs/{meta['sha']}", headers=headers)
            if blob.status_code != 200:
                raise _github_error(blob, cfg)
            content = blob.json().get("content") or ""
        try:
            doc = json.loads(base64.b64decode(content).decode("utf-8")) if content else None
        except (ValueError, UnicodeDecodeError) as e:
            raise SyncError("The sync file on GitHub is damaged.") from e
        _github_sha[memo] = meta.get("sha")
        return {"document": doc, "sha": meta.get("sha")}

    if action == "read":
        return await read()
    if action != "write":
        raise SyncError("Unknown GitHub action.")
    if not isinstance(document, dict) or document.get("format") not in (FORMAT, ENCRYPTED_FORMAT):
        raise SyncError("Nothing to write: the document is not a Citeweave sync file.")
    if sha is None:
        sha = _github_sha[memo] if memo in _github_sha else (await read()).get("sha")
    body = {"message": "Citeweave sync", "branch": cfg["branch"],
            "content": base64.b64encode(json.dumps(document, ensure_ascii=False).encode("utf-8")).decode("ascii")}
    if sha:
        body["sha"] = sha
    resp = await http.put(url, json=body, headers=headers)
    if resp.status_code not in (200, 201):
        _github_sha.pop(memo, None)
        raise _github_error(resp, cfg)
    new_sha = (resp.json().get("content") or {}).get("sha")
    _github_sha[memo] = new_sha
    return {"sha": new_sha}
