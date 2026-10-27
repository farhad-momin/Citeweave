"""Local web server that powers the desktop window and the browser extension.

It listens only on 127.0.0.1. Requests from web pages are refused; only the app's own
window and the Citeweave browser extension may call it.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__, aggregator, graph, jobs, library, sync, zotero
from . import sources as S
from .ai import providers, tasks
from .config import data_dir, settings
from .db import db
from .formats import apa, detect_and_parse, find_dois, rows_to_csv, to_bibtex, to_csv, to_ris
from .models import dedupe, make_paper, parse_identifier, title_similarity
from .net import close_client

log = logging.getLogger("citeweave")
STATIC = Path(__file__).parent / "static"

# what the browser extension sent most recently, shown by the app window
_inbox: list[dict] = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    db().cache_prune()
    library.ensure_default()
    yield
    await close_client()


app = FastAPI(title="Citeweave", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)

EXT_ORIGIN = re.compile(r"^(chrome-extension|moz-extension|extension|ms-browser-extension|safari-web-extension)://")


def _allowed_hosts() -> set[str]:
    port = settings().get("port")
    return {f"127.0.0.1:{port}", f"localhost:{port}", "127.0.0.1", "localhost", "testserver"}


@app.middleware("http")
async def guard(request: Request, call_next):
    """Block DNS rebinding and cross-site requests from ordinary web pages."""
    host = request.headers.get("host", "")
    if host not in _allowed_hosts() and not host.startswith(("127.0.0.1:", "localhost:")):
        return JSONResponse({"detail": "Forbidden host"}, status_code=403)
    origin = request.headers.get("origin")
    is_ext = bool(origin and EXT_ORIGIN.match(origin))
    if origin and not is_ext:
        o = re.sub(r"^https?://", "", origin)
        same_origin = o == host  # the app window itself, on whatever local port it runs
        if not same_origin and o not in _allowed_hosts():
            return JSONResponse({"detail": "Requests from web pages are not allowed"}, status_code=403)
    if request.method == "OPTIONS" and is_ext:
        resp = Response(status_code=204)
    else:
        resp = await call_next(request)
    if is_ext:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Vary"] = "Origin"
    resp.headers.setdefault("Cache-Control", "no-store")
    return resp


@app.exception_handler(providers.AIError)
async def ai_error(_: Request, exc: providers.AIError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


# app shell -----------------------------------------------------------------------
@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


# status and settings --------------------------------------------------------------
@app.get("/api/status")
async def status():
    cfg = providers.active_config()
    return {
        "version": __version__,
        "platform": "desktop",
        "data_dir": str(data_dir()),
        "ai": {"enabled": providers.is_enabled(), "provider": cfg.get("provider"), "model": cfg.get("model"),
               "label": cfg.get("label")},
        "sources": [s.info() for s in S.ALL.values()],
        "search_order": aggregator.search_order(),
    }


@app.get("/api/settings")
async def get_settings():
    return settings().public()


@app.put("/api/settings")
async def put_settings(patch: dict = Body(...)):
    if "port" in patch and not (isinstance(patch["port"], int) and 1024 < patch["port"] < 65535):
        patch.pop("port")
    return settings().update(patch)


@app.get("/api/ai/presets")
async def ai_presets():
    return [{"name": p.name, "label": p.label, "base_url": p.base_url, "default_model": p.default_model,
             "needs_key": p.needs_key, "key_help": p.key_help, "local": p.local} for p in providers.PRESETS.values()]


@app.post("/api/ai/test")
async def ai_test():
    if providers.active_config().get("provider") == "none":
        raise HTTPException(400, "Choose an AI provider first.")
    reply = await providers.chat("Reply with exactly: OK", "Say OK.", max_tokens=10, timeout=60)
    return {"ok": True, "reply": reply.strip()[:100], "model": providers.active_config()["model"]}


@app.post("/api/ai/models")
async def ai_models():
    return {"models": await providers.list_models()}


@app.get("/api/ai/builtin")
async def ai_builtin():
    # The browser's built-in model exists only in the web version.
    return {"available": "unavailable"}


@app.post("/api/ai/verify")
async def ai_verify(body: dict = Body(...)):
    """Check paper suggestions (from an AI or a pasted chatbot reply) against the databases."""
    items = [i for i in (body.get("items") or []) if isinstance(i, dict)][:25]
    if not items:
        raise HTTPException(400, "No suggestions to check.")
    out = await tasks.verify_suggestions(items)
    saved = set(library.saved_ids())
    for p in out["results"]:
        p["saved"] = p["id"] in saved
    return out


@app.post("/api/cache/clear")
async def cache_clear():
    return {"removed": db().cache_clear()}


# search and papers ------------------------------------------------------------------
def _filters(year_from, year_to, oa_only, sort) -> dict:
    return {"year_from": year_from, "year_to": year_to, "oa_only": oa_only, "sort": sort}


@app.get("/api/search")
async def search(q: str = Query(..., min_length=1), source: str = "auto", limit: int = Query(25, le=100),
                 year_from: int | None = None, year_to: int | None = None, oa_only: bool = False,
                 sort: str = "relevance"):
    parsed = parse_identifier(q)
    if parsed and parsed[0] not in ("orcid",) and len(q.split()) == 1:
        p = await aggregator.lookup(*parsed)
        return {"results": [p] if p else [], "used": ["lookup"], "errors": {} if p else {"lookup": "Not found"}}
    if source == "ai":
        out = await tasks.suggest(q, limit=min(limit, 15))
        return {"results": out["results"], "used": ["ai"], "errors": {}, "rejected": out["rejected"]}
    out = await aggregator.search(q, source=source, limit=limit, filters=_filters(year_from, year_to, oa_only, sort))
    saved = set(library.saved_ids())
    for p in out["results"]:
        p["saved"] = p["id"] in saved
    return out


@app.get("/api/autocomplete")
async def autocomplete(q: str):
    if len(q) < 3 or not S.openalex.ready()[0]:
        return []
    try:
        return await S.openalex.autocomplete(q)
    except Exception:  # noqa: BLE001
        return []


async def _paper_from(ref: Any) -> dict:
    """Accept a paper object, a stored id like 'doi:10...', or any identifier."""
    if isinstance(ref, dict) and ref.get("id"):
        return ref
    ref = str(ref or "")
    stored = db().get_paper(ref)
    if stored:
        return stored
    value = ref.split(":", 1)[1] if ref.split(":", 1)[0] in ("doi", "arxiv", "pmid", "pmcid", "openalex", "s2") else ref
    kind = ref.split(":", 1)[0] if value != ref else None
    p = await (aggregator.lookup(kind, value) if kind else aggregator.resolve(ref))
    if not p:
        raise HTTPException(404, f"Could not find a paper for '{ref}'")
    return p


@app.get("/api/paper")
async def paper(id: str):
    p = await _paper_from(id)
    return await _details(p)


@app.post("/api/paper/details")
async def paper_details(body: dict = Body(...)):
    p = await _paper_from(body.get("paper") or body.get("id"))
    return await _details(p)


async def _details(p: dict) -> dict:
    p = await aggregator.enrich(p)
    db().upsert_paper(p)
    p["collections"] = library.paper_memberships(p["id"])
    p["note"] = library.get_note(p["id"])
    p["tags"] = library.tag_map().get(p["id"], [])
    p["apa"] = apa(p)
    return p


@app.post("/api/paper/references")
async def paper_references(body: dict = Body(...)):
    p = await _paper_from(body.get("paper") or body.get("id"))
    return await aggregator.references(p, int(body.get("limit") or 200))


@app.post("/api/paper/citations")
async def paper_citations(body: dict = Body(...)):
    p = await _paper_from(body.get("paper") or body.get("id"))
    return await aggregator.citations(p, int(body.get("limit") or 200))


@app.post("/api/paper/summarize")
async def paper_summarize(body: dict = Body(...)):
    p = await _paper_from(body.get("paper") or body.get("id"))
    return await tasks.summarize(p, use_ai=body.get("use_ai", True))


@app.post("/api/cite")
async def cite(body: dict = Body(...)):
    papers = [await _paper_from(x) for x in body.get("papers", [])]
    fmt = body.get("format", "apa")
    text = {"bibtex": to_bibtex, "ris": to_ris}.get(fmt, lambda ps: "\n\n".join(apa(p) for p in ps))(papers)
    return {"text": text}


@app.post("/api/recommend")
async def recommend(body: dict = Body(...)):
    if body.get("collection_id"):
        papers = library.collection_papers(int(body["collection_id"]))
    else:
        papers = [await _paper_from(x) for x in body.get("papers", [])]
    if not papers:
        raise HTTPException(400, "Add some papers first.")
    return await aggregator.recommend(papers[:50], limit=int(body.get("limit") or 30))


# jobs ---------------------------------------------------------------------------------------
@app.get("/api/jobs/{job_id}")
async def job(job_id: str):
    j = jobs.get(job_id)
    if not j:
        raise HTTPException(404, "Job not found")
    return j


@app.delete("/api/jobs/{job_id}")
async def job_cancel(job_id: str):
    return {"cancelled": jobs.cancel(job_id)}


@app.post("/api/map")
async def map_build(body: dict = Body(...)):
    refs = body.get("seeds") or []
    if not refs:
        raise HTTPException(400, "Add at least one seed paper.")
    max_nodes = max(10, min(int(body.get("max_nodes") or 40), 120))

    async def run(progress):
        progress("Looking up seed papers", 0.05)
        seeds = []
        for r in refs[:20]:
            p = await _paper_from(r)
            if not (p.get("ids") or {}).get("openalex") and p.get("doi"):
                p = await aggregator.lookup("doi", p["doi"]) or p
            seeds.append(p)
        return await graph.build_map(seeds, max_nodes=max_nodes, progress=progress)

    return {"job": jobs.start("map", run)}


@app.post("/api/ask")
async def ask(body: dict = Body(...)):
    question = (body.get("question") or "").strip()
    if not question:
        raise HTTPException(400, "Type a research question.")

    async def run(progress):
        return await tasks.ask(question, limit=int(body.get("limit") or 8), source=body.get("source") or "auto",
                               filters=body.get("filters") or {}, use_ai=body.get("use_ai", True), progress=progress)

    return {"job": jobs.start("ask", run)}


@app.get("/api/extract/presets")
async def extract_presets():
    return tasks.PRESET_COLUMNS


@app.post("/api/extract")
async def extract(body: dict = Body(...)):
    columns = [c for c in body.get("columns") or [] if (c.get("name") or "").strip()]
    if not columns:
        raise HTTPException(400, "Add at least one column.")
    refs = body.get("papers") or []
    if body.get("collection_id"):
        refs = library.collection_papers(int(body["collection_id"]))
    if not refs:
        raise HTTPException(400, "Choose papers for the table.")
    name = (body.get("name") or "").strip() or f"Table {dt.date.today().isoformat()}"

    async def run(progress):
        papers = [await _paper_from(r) for r in refs[:200]]
        rows = await tasks.extract(papers, columns, progress=progress, use_ai=body.get("use_ai", True))
        for r, p in zip(rows, papers):
            r["paper"] = {k: p.get(k) for k in ("id", "title", "year", "doi", "authors", "venue", "oa_url")}
        table_id = library.save_table(name, columns, rows)
        return {"id": table_id, "name": name, "columns": columns, "rows": rows}

    return {"job": jobs.start("extract", run)}


# library ------------------------------------------------------------------------------------
@app.get("/api/collections")
async def collections():
    return library.list_collections()


@app.post("/api/collections")
async def collection_create(body: dict = Body(...)):
    return library.create_collection(body.get("name", ""), body.get("description", ""))


@app.patch("/api/collections/{cid}")
async def collection_update(cid: int, body: dict = Body(...)):
    library.rename_collection(cid, body.get("name", ""), body.get("description"))
    return {"ok": True}


@app.delete("/api/collections/{cid}")
async def collection_delete(cid: int):
    library.delete_collection(cid)
    return {"ok": True}


@app.get("/api/collections/{cid}/papers")
async def collection_list(cid: int):
    return library.collection_papers(cid)


@app.post("/api/collections/{cid}/papers")
async def collection_add(cid: int, body: dict = Body(...)):
    papers = [await _paper_from(x) for x in (body.get("papers") or [])]
    return {"added": library.add_papers(cid, papers)}


@app.post("/api/collections/{cid}/remove")
async def collection_remove(cid: int, body: dict = Body(...)):
    library.remove_paper(cid, body["paper_id"])
    return {"ok": True}


@app.post("/api/collections/{cid}/status")
async def collection_status(cid: int, body: dict = Body(...)):
    try:
        library.set_status(cid, body["paper_id"], body["status"])
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}


@app.put("/api/notes")
async def note(body: dict = Body(...)):
    try:
        library.set_note(body["paper_id"], body.get("body", ""))
    except KeyError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}


@app.put("/api/tags")
async def tags(body: dict = Body(...)):
    library.set_tags(body["paper_id"], body.get("tags") or [])
    return {"ok": True}


# saved maps -------------------------------------------------------------------------------
@app.get("/api/maps")
async def maps():
    return library.list_maps()


@app.post("/api/maps")
async def map_save(body: dict = Body(...)):
    mid = library.save_map(body.get("name") or "Untitled map", body.get("seeds") or [], body.get("options") or {},
                           body.get("known") or [], body.get("id"))
    return {"id": mid}


@app.get("/api/maps/{map_id}")
async def map_get(map_id: int):
    m = library.get_map(map_id)
    if not m:
        raise HTTPException(404, "Map not found")
    return m


@app.delete("/api/maps/{map_id}")
async def map_delete(map_id: int):
    library.delete_map(map_id)
    return {"ok": True}


@app.post("/api/maps/{map_id}/check")
async def map_check(map_id: int):
    """New papers citing the map's seeds since the last check."""
    m = library.get_map(map_id)
    if not m:
        raise HTTPException(404, "Map not found")
    if not S.openalex.ready()[0]:
        raise HTTPException(400, "Checking for new papers uses OpenAlex. Turn it on in Settings.")
    since = dt.date.fromtimestamp(m.get("last_checked") or m["created_at"]) - dt.timedelta(days=7)
    ids = []
    for s in m["seeds"]:
        p = await _paper_from(s)
        oid = (p.get("ids") or {}).get("openalex")
        if not oid and p.get("doi"):
            p = await aggregator.lookup("doi", p["doi"]) or p
            oid = (p.get("ids") or {}).get("openalex")
        if oid:
            ids.append(oid)
    found = await S.openalex.cited_by_any(ids, since.isoformat())
    known = set(m.get("known") or [])
    new = [p for p in dedupe(found) if graph.node_key(p) not in known]
    library.touch_map(map_id, list(known | {graph.node_key(p) for p in new}))
    return {"since": since.isoformat(), "results": new}


# tables -----------------------------------------------------------------------------------------
@app.get("/api/tables")
async def tables():
    return library.list_tables()


@app.post("/api/tables")
async def table_save(body: dict = Body(...)):
    """Save a table filled elsewhere, for example by the researcher's own chatbot."""
    columns = [c for c in body.get("columns") or [] if (c.get("name") or "").strip()]
    if not columns:
        raise HTTPException(400, "Add at least one column.")
    name = (body.get("name") or "").strip() or f"Table {dt.date.today().isoformat()}"
    rows = body.get("rows") or []
    for r in rows:
        p = r.get("paper")
        if isinstance(p, dict) and p.get("id") and not db().get_paper(p["id"]):
            db().upsert_paper(p)
    table_id = library.save_table(name, columns, rows, body.get("id"))
    return {"id": table_id, "name": name}


@app.delete("/api/tables/{table_id}")
async def table_delete(table_id: int):
    library.delete_table(table_id)
    return {"ok": True}


@app.get("/api/tables/{table_id}/csv")
async def table_csv(table_id: int):
    t = next((x for x in library.list_tables() if x["id"] == table_id), None)
    if not t:
        raise HTTPException(404, "Table not found")
    papers = {r["paper_id"]: r.get("paper") or {} for r in t["rows"]}
    csv_text = rows_to_csv(tasks.table_to_csv_rows(t["columns"], t["rows"], papers))
    fname = re.sub(r"[^\w\-]+", "_", t["name"]) + ".csv"
    return Response("﻿" + csv_text, media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


# question history ---------------------------------------------------------------------------
@app.get("/api/history")
async def history_list():
    return library.list_history()


@app.post("/api/history")
async def history_add(body: dict = Body(...)):
    try:
        return library.add_history(body.get("question") or "", body.get("answer") or "",
                                   body.get("papers") or [], body.get("mode") or "")
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.delete("/api/history/{hid}")
async def history_delete(hid: int):
    if not library.delete_history(hid):
        raise HTTPException(404, "Not found")
    return {"ok": True}


# sync (format in web/SPEC.md) -------------------------------------------------------------------
@app.exception_handler(sync.SyncError)
async def sync_error(_: Request, exc: sync.SyncError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.get("/api/sync/export")
async def sync_export():
    return sync.export_document()


@app.post("/api/sync/import")
async def sync_import(body: dict = Body(...)):
    return sync.import_document(body)


@app.get("/api/sync/folder")
async def sync_folder_read():
    return sync.read_folder()


@app.put("/api/sync/folder")
async def sync_folder_write(body: dict = Body(...)):
    return sync.write_folder(body)


@app.post("/api/sync/folder/pick")
async def sync_folder_pick():
    from starlette.concurrency import run_in_threadpool

    def pick() -> str | None:
        try:
            import webview  # pywebview
        except ImportError:
            return None
        if not getattr(webview, "windows", None):
            return None
        kind = getattr(getattr(webview, "FileDialog", None), "FOLDER", None) or getattr(webview, "FOLDER_DIALOG", 20)
        chosen = webview.windows[0].create_file_dialog(kind)
        if not chosen:
            return ""
        return chosen[0] if isinstance(chosen, (list, tuple)) else str(chosen)

    path = await run_in_threadpool(pick)
    if path is None:
        raise HTTPException(400, "The folder picker only works in the Citeweave app window. Type the folder path instead.")
    if path:
        settings().update({"sync": {"folder": path}})
    return {"path": path}


@app.post("/api/sync/github")
async def sync_github(body: dict = Body(...)):
    return await sync.github(body.get("action") or "", body.get("document"), body.get("sha"))


# import / export ------------------------------------------------------------------------------
@app.post("/api/export")
async def export(body: dict = Body(...)):
    if body.get("collection_id"):
        papers = library.collection_papers(int(body["collection_id"]))
    else:
        papers = [await _paper_from(x) for x in body.get("papers", [])]
    fmt = body.get("format", "bibtex")
    if fmt == "bibtex":
        return PlainTextResponse(to_bibtex(papers), media_type="application/x-bibtex")
    if fmt == "ris":
        return PlainTextResponse(to_ris(papers), media_type="application/x-research-info-systems")
    if fmt == "csv":
        return PlainTextResponse("﻿" + to_csv(papers), media_type="text/csv")
    raise HTTPException(400, "format must be bibtex, ris or csv")


@app.post("/api/import")
async def import_text(body: dict = Body(...)):
    text = body.get("text") or ""
    cid = int(body.get("collection_id") or library.ensure_default())
    kind, papers = detect_and_parse(text)

    async def run(progress):
        resolved: list[dict] = []
        items = papers
        if kind == "dois":
            dois = find_dois(text)
            idents = dois or [ln.strip() for ln in text.splitlines() if parse_identifier(ln.strip())]
            for i, d in enumerate(idents[:500]):
                progress(f"Looking up {i + 1} of {len(idents)}", i / max(len(idents), 1))
                try:
                    p = await aggregator.resolve(d)
                except Exception:  # noqa: BLE001
                    p = None
                if p:
                    resolved.append(p)
            items = resolved
        else:
            for i, p in enumerate(items):
                progress(f"Checking {i + 1} of {len(items)}", i / max(len(items), 1))
                if p.get("doi") and not p.get("abstract"):
                    try:
                        full = await aggregator.lookup("doi", p["doi"])
                        if full:
                            items[i] = full
                    except Exception:  # noqa: BLE001
                        pass
        added = library.add_papers(cid, items)
        return {"format": kind, "found": len(items), "added": added, "collection_id": cid}

    return {"job": jobs.start("import", run)}


@app.get("/api/zotero/status")
async def zotero_status():
    return await zotero.status()


@app.post("/api/zotero/send")
async def zotero_send(body: dict = Body(...)):
    if body.get("collection_id"):
        papers = library.collection_papers(int(body["collection_id"]))
    else:
        papers = [await _paper_from(x) for x in body.get("papers", [])]
    try:
        return await zotero.send(papers)
    except RuntimeError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/zotero/collections")
async def zotero_collections():
    try:
        return await zotero.collections()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, str(e)) from e


@app.post("/api/zotero/import")
async def zotero_import(body: dict = Body(...)):
    try:
        items = await zotero.read_items(body.get("collection_key"))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, str(e)) from e
    cid = body.get("collection_id")
    if not cid:
        cid = library.create_collection(body.get("name") or "From Zotero")["id"]
    return {"added": library.add_papers(int(cid), items), "collection_id": cid, "found": len(items)}


# researcher profile --------------------------------------------------------------------------
def h_index(counts: list[int]) -> int:
    counts = sorted((c or 0 for c in counts), reverse=True)
    return sum(1 for i, c in enumerate(counts, 1) if c >= i)


@app.post("/api/profile/load")
async def profile_load(body: dict = Body(...)):
    kind = body.get("kind")
    value = (body.get("value") or "").strip()
    if not value:
        raise HTTPException(400, "Enter an identifier.")

    async def run(progress):
        progress("Loading works", 0.2)
        info, works = None, []
        if kind == "orcid":
            m = re.search(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]", value, re.I)
            if not m:
                raise ValueError("That does not look like an ORCID iD (0000-0000-0000-0000).")
            oid = m.group(0).upper()
            if S.openalex.ready()[0]:
                try:
                    info, works = await S.openalex.author_works(orcid=oid)
                except Exception:  # noqa: BLE001
                    info, works = None, []
            try:
                o_info, o_works = await S.orcid.works(oid)
            except Exception:  # noqa: BLE001 - OpenAlex may still have the record
                if not works:
                    raise
                o_info, o_works = None, []
            if o_info:
                info = {**(o_info or {}), **(info or {})}
                if o_info.get("name"):
                    info["name"] = o_info["name"]
            have = {w.get("doi") for w in works if w.get("doi")}
            missing = [w for w in o_works if not w.get("doi") or w["doi"] not in have]
            dois = [w["doi"] for w in missing if w.get("doi")]
            if dois and S.openalex.ready()[0]:
                progress("Filling in details", 0.6)
                try:
                    found = await S.openalex.batch_dois(dois)
                    got = {f["doi"] for f in found}
                    missing = [w for w in missing if w.get("doi") not in got] + found
                except Exception:  # noqa: BLE001
                    pass
            works = dedupe(works + missing)
        elif kind == "openalex":
            info, works = await S.openalex.author_works(author_id=value.rstrip("/").split("/")[-1])
        elif kind == "s2":
            info, works = await S.semanticscholar.author_works(value.rstrip("/").split("/")[-1])
        elif kind == "scopus":
            ok, reason = S.scopus.ready()
            if not ok:
                raise ValueError(reason)
            info, works = await S.scopus.author_works(re.sub(r"\D", "", value))
        else:
            raise ValueError("Unknown identifier type")
        if not info and not works:
            raise ValueError("No public record found for that identifier.")
        info = info or {}
        cites = [w.get("cited_by_count") or 0 for w in works]
        info["computed"] = {"works": len(works), "citations": sum(cites), "h_index": h_index(cites),
                            "i10_index": sum(1 for c in cites if c >= 10)}
        works.sort(key=lambda w: (w.get("year") or 0, w.get("cited_by_count") or 0), reverse=True)
        field = {"orcid": "orcid", "openalex": "openalex_author", "s2": "s2_author", "scopus": "scopus_author"}[kind]
        settings().update({"profile": {field: value}})
        return {"info": info, "works": works}

    return {"job": jobs.start("profile", run)}


# browser extension ----------------------------------------------------------------------------
@app.get("/api/ext/ping")
async def ext_ping():
    return {"app": "Citeweave", "version": __version__, "collections": library.list_collections()}


@app.post("/api/ext/lookup")
async def ext_lookup(body: dict = Body(...)):
    try:
        return await asyncio.wait_for(_ext_lookup(body), timeout=25)
    except asyncio.TimeoutError:
        page = body.get("page") or {}
        if page.get("title"):
            return await _ext_lookup({**body, "identifier": "", "title": "", "offline": True})
        raise HTTPException(504, "The databases took too long to answer. Try again in a moment.") from None


async def _ext_lookup(body: dict) -> dict:
    """Identify the paper on a web page. Tries the identifier, then a verified title search, and
    finally falls back to the page's own citation tags so saving works even when offline."""
    ident = (body.get("identifier") or "").strip()
    page = body.get("page") or {}
    title = (body.get("title") or page.get("title") or "").strip()
    p = None
    if ident and not body.get("offline"):
        try:
            p = await aggregator.resolve(ident)
        except Exception as e:  # noqa: BLE001
            log.info("Lookup of %s failed: %s", ident, e)
    if not p and title and len(title) > 15 and not body.get("offline"):
        try:
            found = await aggregator.search(title, limit=5)
            best = max(found["results"], key=lambda r: title_similarity(title, r.get("title")), default=None)
            if best and title_similarity(title, best.get("title")) >= 0.7:
                p = best
        except Exception as e:  # noqa: BLE001
            log.info("Title search failed: %s", e)
    page_ident = (body.get("page") or {}).get("identifier") or ident
    if not p and page.get("title") and (page_ident or page.get("authors")):
        kind_val = parse_identifier(page_ident) if page_ident else None
        ids = {kind_val[0]: kind_val[1]} if kind_val and kind_val[0] in ("arxiv", "pmid", "pmcid") else {}
        p = make_paper(source="page", title=page["title"], doi=kind_val[1] if kind_val and kind_val[0] == "doi" else None,
                       year=page.get("year"), venue=page.get("journal"), oa_url=page.get("pdf") or None,
                       authors=[{"name": a} for a in page.get("authors") or []], url=page.get("url"), ids=ids)
        p["from_page"] = True
    if not p:
        raise HTTPException(404, "Citeweave could not identify a paper on this page.")
    p["collections"] = library.paper_memberships(p["id"])
    return p


@app.post("/api/ext/save")
async def ext_save(body: dict = Body(...)):
    p = body.get("paper") or await ext_lookup(body)
    cid = int(body.get("collection_id") or library.ensure_default())
    library.add_papers(cid, [p])
    _inbox.append({"action": "saved", "paper": p, "collection_id": cid})
    return {"ok": True, "paper_id": p["id"], "collection_id": cid}


@app.post("/api/ext/open")
async def ext_open(body: dict = Body(...)):
    p = body.get("paper") or await ext_lookup(body)
    _inbox.append({"action": body.get("action") or "open", "paper": p})
    return {"ok": True}


@app.get("/api/inbox")
async def inbox():
    items = list(_inbox)
    _inbox.clear()
    return items
