"""Use Citeweave from the Claude desktop app.

Claude starts this program and talks to it over standard input and output using the
Model Context Protocol (newline-delimited JSON-RPC 2.0). It works with the same
library database as the Citeweave window, so it runs even when the window is closed.
The AI work happens in Claude, on the researcher's own subscription; Citeweave
supplies real papers, citation links and a place to save results.

  python -m citeweave.mcp_server
  python -m citeweave --mcp
  citeweave-mcp.exe            (packaged Windows app)
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import sys
from typing import Any, Callable

from . import __version__

PROTOCOL_VERSION = "2025-06-18"
log = logging.getLogger("citeweave.mcp")


def _authors(p: dict, n: int = 3) -> str:
    names = [a.get("name", "") for a in p.get("authors") or [] if a.get("name")]
    return ", ".join(names[:n]) + (" et al." if len(names) > n else "")


def compact(p: dict, abstract_chars: int = 500) -> dict:
    out = {
        "id": p.get("id"), "title": p.get("title"), "year": p.get("year"), "authors": _authors(p),
        "venue": p.get("venue"), "doi": p.get("doi"), "cited_by_count": p.get("cited_by_count"),
    }
    if p.get("oa_url"):
        out["open_access_pdf"] = p["oa_url"]
    if abstract_chars and (p.get("abstract") or p.get("tldr")):
        text = p.get("abstract") or p.get("tldr") or ""
        out["abstract"] = text if len(text) <= abstract_chars else text[:abstract_chars].rsplit(" ", 1)[0] + "..."
    return {k: v for k, v in out.items() if v not in (None, "", [])}


# tools ------------------------------------------------------------------------------------
async def _resolve(identifier: str) -> dict | None:
    from . import aggregator
    from .db import db
    from .models import parse_identifier

    ident = str(identifier or "").strip()
    if not ident:
        return None
    stored = db().get_paper(ident)
    if stored:
        return stored
    kind, _, value = ident.partition(":")
    if value and kind in ("doi", "arxiv", "pmid", "pmcid", "openalex", "s2"):
        return await aggregator.lookup(kind, value)
    if parse_identifier(ident):
        return await aggregator.resolve(ident)
    found = await aggregator.search(ident, limit=3)
    return found["results"][0] if found["results"] else None


async def _need(identifier: str) -> dict:
    p = await _resolve(identifier)
    if not p:
        raise ToolError(f"No paper found for '{identifier}'. Use a DOI, arXiv id, PubMed id, or a Citeweave paper id.")
    return p


def _collection(ref: Any, create: bool = False) -> dict:
    from . import library

    c = library.find_collection(ref)
    if c:
        return c
    if create and str(ref or "").strip() and not str(ref).isdigit():
        made = library.create_collection(str(ref))
        return library.find_collection(made["id"])
    names = ", ".join(x["name"] for x in library.list_collections()) or "none yet"
    raise ToolError(f"No collection called '{ref}'. Collections: {names}.")


async def search_papers(query: str, source: str = "auto", limit: int = 10, year_from: int | None = None,
                        year_to: int | None = None) -> dict:
    from . import aggregator

    limit = max(1, min(int(limit or 10), 50))
    out = await aggregator.search(query, source=source or "auto", limit=limit,
                                  filters={"year_from": year_from, "year_to": year_to})
    return {"results": [compact(p) for p in out["results"][:limit]], "sources_used": out["used"],
            "errors": out["errors"]}


async def get_paper(identifier: str) -> dict:
    from . import library

    p = await _need(identifier)
    out = compact(p, abstract_chars=0)
    out.update({k: p[k] for k in ("abstract", "tldr", "topics", "ids", "url", "type") if p.get(k)})
    out["authors"] = [a.get("name") for a in p.get("authors") or []]
    cols = {c["id"]: c["name"] for c in library.list_collections()}
    out["in_collections"] = [cols[i] for i in library.paper_memberships(p["id"]) if i in cols]
    note = library.get_note(p["id"])
    if note:
        out["note"] = note
    return out


async def get_references(identifier: str, limit: int = 50) -> dict:
    from . import aggregator

    p = await _need(identifier)
    out = await aggregator.references(p, max(1, min(int(limit or 50), 200)))
    return {"paper": p.get("title"), "count": len(out["results"]), "references": [compact(x, 0) for x in out["results"]]}


async def get_citations(identifier: str, limit: int = 50) -> dict:
    from . import aggregator

    p = await _need(identifier)
    out = await aggregator.citations(p, max(1, min(int(limit or 50), 200)))
    return {"paper": p.get("title"), "count": len(out["results"]), "cited_by": [compact(x, 0) for x in out["results"]]}


async def list_collections() -> dict:
    from . import library

    return {"collections": [{"id": c["id"], "name": c["name"], "papers": c["count"], "description": c["description"]}
                            for c in library.list_collections()]}


async def get_collection(collection: str, include_abstracts: bool = False) -> dict:
    from . import library

    c = _collection(collection)
    papers = []
    for p in library.collection_papers(c["id"]):
        item = compact(p, 1500 if include_abstracts else 0)
        item["status"] = p.get("status")
        if p.get("note"):
            item["note"] = p["note"]
        if p.get("tags"):
            item["tags"] = p["tags"]
        papers.append(item)
    return {"id": c["id"], "name": c["name"], "count": len(papers), "papers": papers}


async def add_to_collection(collection: str, identifiers: list[str], create_if_missing: bool = True) -> dict:
    from . import library

    c = _collection(collection, create=create_if_missing)
    found, missing = [], []
    for ident in identifiers or []:
        p = await _resolve(ident)
        (found if p else missing).append(p or ident)
    added = library.add_papers(c["id"], found)
    return {"collection": c["name"], "added": added, "already_there": len(found) - added,
            "not_found": missing, "papers": [compact(p, 0) for p in found]}


async def build_citation_map(identifiers: list[str], max_nodes: int = 30) -> dict:
    from . import graph

    seeds = [await _need(i) for i in (identifiers or [])[:10]]
    if not seeds:
        raise ToolError("Give at least one seed paper.")
    m = await graph.build_map(seeds, max_nodes=max(5, min(int(max_nodes or 30), 100)))
    ranked = []
    for n in sorted(m["nodes"], key=lambda x: (not x.get("seed"), -(x.get("score") or 0))):
        item = compact(n["paper"], 0)
        item["seed"] = bool(n.get("seed"))
        item["score"] = round(float(n.get("score") or 0), 3)
        ranked.append(item)
    return {
        "papers": ranked,
        "citation_links": len(m.get("edges") or []),
        "foundations": [compact(x.get("paper") or x, 0) for x in (m.get("foundational") or [])[:10]],
        "newer_work": [compact(x.get("paper") or x, 0) for x in (m.get("newer") or [])[:10]],
        "errors": m.get("errors") or {},
    }


async def save_table(name: str, columns: list[dict], rows: list[dict]) -> dict:
    from . import library
    from .db import db

    cols = [{"name": str(c.get("name") or "").strip(), "instruction": str(c.get("description") or c.get("name") or "")}
            for c in columns or [] if str(c.get("name") or "").strip()]
    if not cols:
        raise ToolError("Give at least one column with a name.")
    names = [c["name"] for c in cols]
    out_rows, skipped = [], []
    for r in rows or []:
        ident = r.get("paper_id") or r.get("identifier")
        p = await _resolve(ident) if ident else None
        if not p:
            skipped.append(ident)
            continue
        db().upsert_paper(p)
        cells = r.get("cells") or {}
        quotes = r.get("quotes") or {}
        values = {n: {"value": str(cells.get(n, "Not reported")), "quote": str(quotes.get(n, ""))} for n in names}
        out_rows.append({"paper_id": p["id"], "based_on": "Claude", "values": values, "error": None,
                         "paper": {k: p.get(k) for k in ("id", "title", "year", "doi", "authors", "venue", "oa_url")}})
    if not out_rows:
        raise ToolError("None of the rows matched a paper. Use the paper ids returned by the other tools.")
    title = (name or "").strip() or f"Table {dt.date.today().isoformat()}"
    tid = library.save_table(title, cols, out_rows)
    return {"id": tid, "name": title, "rows_saved": len(out_rows), "not_found": skipped,
            "note": "Open Citeweave, Tables, to see it and export to CSV."}


async def save_answer(question: str, answer: str, paper_ids: list[str] | None = None) -> dict:
    from . import library

    papers = []
    for ident in paper_ids or []:
        p = await _resolve(ident)
        if p:
            papers.append({k: p.get(k) for k in ("id", "title", "year", "doi", "authors", "venue")})
    item = library.add_history(question, answer, papers, "claude")
    return {"id": item["id"], "saved": True, "papers_linked": len(papers)}


async def export_bibtex(collection: str) -> dict:
    from . import library
    from .formats import to_bibtex

    c = _collection(collection)
    return {"collection": c["name"], "bibtex": to_bibtex(library.collection_papers(c["id"]))}


def _s(t: str, desc: str, **extra) -> dict:
    return {"type": t, "description": desc, **extra}


TOOLS: dict[str, tuple[Callable, str, dict]] = {
    "search_papers": (search_papers, "Search open scholarly databases (OpenAlex, Semantic Scholar, Crossref, "
                      "Europe PMC, arXiv, PubMed) for real papers. Returns titles, authors, year, DOI, citation "
                      "counts and abstracts.", {
                          "type": "object", "required": ["query"], "properties": {
                              "query": _s("string", "Topic, keywords or title"),
                              "source": _s("string", "auto (default) or one source name, e.g. openalex, pubmed"),
                              "limit": _s("integer", "Number of results, 1 to 50 (default 10)"),
                              "year_from": _s("integer", "Earliest publication year"),
                              "year_to": _s("integer", "Latest publication year")}}),
    "get_paper": (get_paper, "Full details of one paper: abstract, authors, ids, open access link, and which "
                  "of the researcher's collections it is in.", {
                      "type": "object", "required": ["identifier"], "properties": {
                          "identifier": _s("string", "DOI, arXiv id, PMID, article link, Citeweave id, or a title")}}),
    "get_references": (get_references, "Papers that the given paper cites.", {
        "type": "object", "required": ["identifier"], "properties": {
            "identifier": _s("string", "DOI, arXiv id, PMID or Citeweave id"),
            "limit": _s("integer", "Maximum papers, default 50")}}),
    "get_citations": (get_citations, "Papers that cite the given paper.", {
        "type": "object", "required": ["identifier"], "properties": {
            "identifier": _s("string", "DOI, arXiv id, PMID or Citeweave id"),
            "limit": _s("integer", "Maximum papers, default 50")}}),
    "list_collections": (list_collections, "The researcher's Citeweave collections with paper counts.",
                         {"type": "object", "properties": {}}),
    "get_collection": (get_collection, "Papers in one collection, with reading status, notes and tags.", {
        "type": "object", "required": ["collection"], "properties": {
            "collection": _s("string", "Collection name or id"),
            "include_abstracts": _s("boolean", "Include abstracts (longer output)")}}),
    "add_to_collection": (add_to_collection, "Save papers to a collection in the researcher's library.", {
        "type": "object", "required": ["collection", "identifiers"], "properties": {
            "collection": _s("string", "Collection name or id"),
            "identifiers": _s("array", "DOIs, arXiv ids, PMIDs or Citeweave ids", items={"type": "string"}),
            "create_if_missing": _s("boolean", "Create the collection if it does not exist (default true)")}}),
    "build_citation_map": (build_citation_map, "Find the papers most strongly connected to the seed papers by "
                           "direct citations, shared references and shared citations. Also lists foundation papers "
                           "and newer work.", {
                               "type": "object", "required": ["identifiers"], "properties": {
                                   "identifiers": _s("array", "One to ten seed papers", items={"type": "string"}),
                                   "max_nodes": _s("integer", "Papers on the map, 5 to 100 (default 30)")}}),
    "save_table": (save_table, "Save a literature table into Citeweave (shown on its Tables page and exportable to "
                   "CSV). Fill the cells only from text you have read in the papers.", {
                       "type": "object", "required": ["name", "columns", "rows"], "properties": {
                           "name": _s("string", "Table name"),
                           "columns": _s("array", "Columns", items={"type": "object", "required": ["name"], "properties": {
                               "name": {"type": "string"}, "description": {"type": "string"}}}),
                           "rows": _s("array", "One row per paper", items={"type": "object", "properties": {
                               "paper_id": {"type": "string", "description": "Citeweave id or DOI of the paper"},
                               "cells": {"type": "object", "description": "Column name to value"},
                               "quotes": {"type": "object", "description": "Column name to a supporting quote"}}})}}),
    "save_answer": (save_answer, "Save a question and your sourced answer to the researcher's question history in "
                    "Citeweave.", {
                        "type": "object", "required": ["question", "answer"], "properties": {
                            "question": {"type": "string"}, "answer": {"type": "string"},
                            "paper_ids": _s("array", "Papers the answer cites", items={"type": "string"})}}),
    "export_bibtex": (export_bibtex, "BibTeX for every paper in a collection.", {
        "type": "object", "required": ["collection"], "properties": {
            "collection": _s("string", "Collection name or id")}}),
}


class ToolError(Exception):
    pass


# protocol -----------------------------------------------------------------------------------
def _result(rid: Any, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _error(rid: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


async def handle(msg: dict) -> dict | None:
    method = msg.get("method")
    rid = msg.get("id")
    is_request = "id" in msg
    if method == "initialize":
        asked = (msg.get("params") or {}).get("protocolVersion") or PROTOCOL_VERSION
        return _result(rid, {
            "protocolVersion": asked if isinstance(asked, str) else PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "citeweave", "title": "Citeweave", "version": __version__},
            "instructions": "Citeweave searches open scholarly databases and keeps the researcher's library. "
                            "Cite only papers returned by these tools, and use their ids when saving tables or answers.",
        })
    if method == "ping":
        return _result(rid, {})
    if method == "tools/list":
        return _result(rid, {"tools": [{"name": n, "description": d, "inputSchema": s} for n, (_, d, s) in TOOLS.items()]})
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        if name not in TOOLS:
            return _error(rid, -32602, f"Unknown tool: {name}")
        fn = TOOLS[name][0]
        try:
            out = await fn(**(params.get("arguments") or {}))
            text = json.dumps(out, ensure_ascii=False, default=str)
            return _result(rid, {"content": [{"type": "text", "text": text}], "isError": False})
        except TypeError as e:
            return _result(rid, {"content": [{"type": "text", "text": f"Invalid arguments: {e}"}], "isError": True})
        except Exception as e:  # noqa: BLE001 - errors go back to Claude as text
            log.info("tool %s failed: %s", name, e)
            return _result(rid, {"content": [{"type": "text", "text": str(e) or type(e).__name__}], "isError": True})
    if not is_request:
        return None  # notifications such as notifications/initialized
    return _error(rid, -32601, f"Method not found: {method}")


async def serve(stdin=None, stdout=None) -> None:
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    loop = asyncio.get_running_loop()
    from .net import close_client

    try:
        while True:
            line = await loop.run_in_executor(None, stdin.readline)
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                reply = _error(None, -32700, "Parse error")
            else:
                if isinstance(msg, list):
                    replies = [r for r in [await handle(m) for m in msg if isinstance(m, dict)] if r]
                    reply = replies or None
                else:
                    reply = await handle(msg) if isinstance(msg, dict) else _error(None, -32600, "Invalid request")
            if reply:
                stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
                stdout.flush()
    finally:
        await close_client()


def main() -> None:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(message)s")
    # Windows: make sure JSON goes out as UTF-8 regardless of the console code page
    # and with plain \n line ends (text mode on Windows would write \r\n)
    for stream, extra in ((sys.stdin, {}), (sys.stdout, {"newline": "\n"})):
        try:
            stream.reconfigure(encoding="utf-8", **extra)
        except (AttributeError, ValueError):
            pass
    from . import library

    library.ensure_default()
    asyncio.run(serve())


if __name__ == "__main__":
    main()
