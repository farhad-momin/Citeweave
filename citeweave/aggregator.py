"""One place that talks to all sources: search, look up, references, citations.

Each operation tries the user's preferred sources in order and falls back to the
next one when a source is off, missing a key, out of quota or unreachable.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from . import sources as S
from .config import settings
from .db import db
from .models import dedupe, merge_papers, parse_identifier
from .net import SourceError

log = logging.getLogger("citeweave")


def search_order() -> list[str]:
    order = settings().get("search", "order", default=[]) or []
    names = [n for n in order if n in S.SEARCHABLE] + [n for n in S.SEARCHABLE if n not in order]
    return names


async def search(query: str, source: str = "auto", limit: int = 25, filters: dict | None = None) -> dict:
    """Returns {"results": [...], "used": [...], "errors": {...}}."""
    filters = filters or {}
    errors: dict[str, str] = {}
    if source and source != "auto":
        names = [source]
        mode = "single"
    else:
        names = [n for n in search_order() if S.ALL[n].ready()[0]]
        mode = settings().get("search", "mode", default="fallback")

    async def run(name: str) -> list[dict]:
        src = S.ALL[name]
        ok, reason = src.ready()
        if not ok:
            raise SourceError(reason)
        return await src.search(query, limit=limit, filters=filters)

    results: list[dict] = []
    used: list[str] = []
    if mode == "merge":
        outs = await asyncio.gather(*(run(n) for n in names[:4]), return_exceptions=True)
        for n, out in zip(names[:4], outs):
            if isinstance(out, Exception):
                errors[n] = str(out)
            else:
                used.append(n)
                results += out
        results = dedupe(results)
    else:
        for n in names:
            try:
                out = await run(n)
            except Exception as e:  # noqa: BLE001 - any failure moves to the next source
                errors[n] = str(e)
                continue
            used.append(n)
            results = dedupe(out)
            if results or mode == "single":
                break
    if filters.get("oa_only"):
        results = [p for p in results if p.get("oa_url")] or results
    return {"results": results[:limit * 2], "used": used, "errors": errors}


async def resolve(identifier: str) -> dict | None:
    """Look up one paper from a DOI, arXiv id, PMID, PMCID, OpenAlex or Semantic Scholar id, or URL."""
    parsed = parse_identifier(identifier)
    if not parsed:
        return None
    kind, value = parsed
    return await lookup(kind, value)


async def lookup(kind: str, value: str) -> dict | None:
    key = f"{kind}:{value}"
    if kind == "doi":
        stored = db().get_paper(key)
        if stored and stored.get("abstract") and stored.get("ids", {}).get("openalex"):
            return stored
    chains = {
        "doi": ["openalex", "semanticscholar", "crossref", "europepmc"],
        "arxiv": ["semanticscholar", "openalex", "arxiv"],
        "pmid": ["openalex", "semanticscholar", "europepmc", "pubmed"],
        "pmcid": ["openalex", "semanticscholar", "europepmc"],
        "openalex": ["openalex"],
        "s2": ["semanticscholar"],
    }.get(kind, [])
    found: dict | None = None
    for name in chains:
        src = S.ALL[name]
        if not src.ready()[0]:
            continue
        try:
            p = await src.paper(kind, value)
        except Exception as e:  # noqa: BLE001
            log.info("lookup %s via %s failed: %s", key, name, e)
            continue
        if p:
            found = merge_papers(found, p) if found else p
            # good enough once we have an abstract and an OpenAlex id (needed for maps)
            if found.get("abstract") and found.get("ids", {}).get("openalex"):
                break
    if found:
        db().upsert_paper(found)
    return found


async def enrich(paper: dict) -> dict:
    """Fill gaps: short summary from Semantic Scholar and an open access link from Unpaywall."""
    p = dict(paper)
    tasks: list[Any] = []
    if not p.get("tldr") or not p.get("abstract"):
        if S.semanticscholar.ready()[0] and (p.get("doi") or p.get("ids", {}).get("arxiv") or p.get("ids", {}).get("s2")):
            kind, val = ("doi", p["doi"]) if p.get("doi") else \
                (("arxiv", p["ids"]["arxiv"]) if p.get("ids", {}).get("arxiv") else ("s2", p["ids"]["s2"]))
            tasks.append(S.semanticscholar.paper(kind, val))
    if not p.get("oa_url") and p.get("doi") and S.unpaywall.ready()[0]:
        tasks.append(S.unpaywall.oa_link(p["doi"]))
    outs = await asyncio.gather(*tasks, return_exceptions=True)
    for out in outs:
        if isinstance(out, Exception) or not out:
            continue
        if "pdf" in out and "status" in out:  # unpaywall
            p["oa_url"] = out.get("pdf") or out.get("page") or p.get("oa_url")
            p["oa_status"] = out.get("status")
        else:
            p = merge_papers(p, out)
    return p


async def references(paper: dict, limit: int = 200) -> dict:
    errors: dict[str, str] = {}
    if S.openalex.ready()[0]:
        try:
            out = await S.openalex.references(paper, limit)
            if out:
                return {"results": out, "used": "openalex", "errors": errors}
        except Exception as e:  # noqa: BLE001
            errors["openalex"] = str(e)
    if S.semanticscholar.ready()[0]:
        try:
            out = await S.semanticscholar.references(paper, limit)
            if out:
                return {"results": out, "used": "semanticscholar", "errors": errors}
        except Exception as e:  # noqa: BLE001
            errors["semanticscholar"] = str(e)
    if paper.get("doi"):
        try:
            dois = []
            if S.opencitations.enabled():
                dois = await S.opencitations.reference_dois(paper["doi"])
            if not dois and S.crossref.enabled():
                full = await S.crossref.paper("doi", paper["doi"])
                dois = (full or {}).get("reference_dois") or []
            out = await _papers_for_dois(dois[:limit])
            if out:
                return {"results": out, "used": "opencitations", "errors": errors}
        except Exception as e:  # noqa: BLE001
            errors["opencitations"] = str(e)
    return {"results": [], "used": None, "errors": errors}


async def citations(paper: dict, limit: int = 200) -> dict:
    errors: dict[str, str] = {}
    if S.openalex.ready()[0]:
        try:
            out = await S.openalex.citations(paper, limit)
            if out:
                return {"results": out, "used": "openalex", "errors": errors}
        except Exception as e:  # noqa: BLE001
            errors["openalex"] = str(e)
    if S.semanticscholar.ready()[0]:
        try:
            out = await S.semanticscholar.citations(paper, limit)
            if out:
                return {"results": out, "used": "semanticscholar", "errors": errors}
        except Exception as e:  # noqa: BLE001
            errors["semanticscholar"] = str(e)
    if paper.get("doi") and S.opencitations.enabled():
        try:
            dois = await S.opencitations.citation_dois(paper["doi"])
            out = await _papers_for_dois(dois[:limit])
            if out:
                return {"results": out, "used": "opencitations", "errors": errors}
        except Exception as e:  # noqa: BLE001
            errors["opencitations"] = str(e)
    return {"results": [], "used": None, "errors": errors}


async def _papers_for_dois(dois: list[str]) -> list[dict]:
    if not dois:
        return []
    if S.openalex.ready()[0]:
        try:
            out = await S.openalex.batch_dois(dois)
            if out:
                return out
        except Exception:  # noqa: BLE001
            pass
    if S.semanticscholar.ready()[0]:
        try:
            return await S.semanticscholar.batch([f"DOI:{d}" for d in dois])
        except Exception:  # noqa: BLE001
            pass
    out = []
    for d in dois[:40]:
        try:
            p = await S.crossref.paper("doi", d)
            if p:
                out.append(p)
        except Exception:  # noqa: BLE001
            break
    return out


async def recommend(papers: list[dict], limit: int = 30) -> dict:
    """Papers similar to a set, from Semantic Scholar's recommender plus OpenAlex related works."""
    results: list[dict] = []
    errors: dict[str, str] = {}
    have = {p["id"] for p in papers}
    if S.semanticscholar.ready()[0]:
        try:
            results += await S.semanticscholar.recommend(papers, limit=limit)
        except Exception as e:  # noqa: BLE001
            errors["semanticscholar"] = str(e)
    if S.openalex.ready()[0]:
        for p in papers[:5]:
            try:
                results += await S.openalex.related(p, limit=10)
            except Exception as e:  # noqa: BLE001
                errors["openalex"] = str(e)
                break
    results = [r for r in dedupe(results) if r["id"] not in have]
    return {"results": results[:limit], "errors": errors}
