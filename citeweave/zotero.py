"""Work with a Zotero desktop app running on the same computer.

Sending: Zotero's connector server (port 23119) accepts RIS text, the same way the
Zotero browser connector saves items. Zotero must be open.

Reading: Zotero 7 has a local API. Turn it on in Zotero, Settings, Advanced,
"Allow other applications on this computer to communicate with Zotero".
"""
from __future__ import annotations

import re
import uuid

import httpx

from .formats import to_ris
from .models import make_paper

ZOTERO = "http://127.0.0.1:23119"


async def status() -> dict:
    async with httpx.AsyncClient(timeout=3) as c:
        try:
            r = await c.get(f"{ZOTERO}/connector/ping")
            running = r.status_code == 200
        except httpx.HTTPError:
            return {"running": False, "local_api": False}
        local_api = False
        try:
            r2 = await c.get(f"{ZOTERO}/api/users/0/collections", params={"limit": 1})
            local_api = r2.status_code == 200
        except httpx.HTTPError:
            pass
    return {"running": running, "local_api": local_api}


async def send(papers: list[dict]) -> dict:
    if not papers:
        return {"sent": 0}
    ris = to_ris(papers)
    async with httpx.AsyncClient(timeout=30) as c:
        try:
            r = await c.post(f"{ZOTERO}/connector/import", params={"session": uuid.uuid4().hex},
                             content=ris.encode("utf-8"),
                             headers={"Content-Type": "application/x-research-info-systems",
                                      "X-Zotero-Connector-API-Version": "3"})
        except httpx.HTTPError as e:
            raise RuntimeError("Zotero is not running. Open Zotero and try again.") from e
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Zotero refused the items ({r.status_code}): {r.text[:200]}")
    return {"sent": len(papers)}


async def collections() -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{ZOTERO}/api/users/0/collections")
        if r.status_code != 200:
            raise RuntimeError("Turn on Zotero's local API: Zotero, Settings, Advanced, "
                               "'Allow other applications on this computer to communicate with Zotero'.")
        return [{"key": x["key"], "name": x["data"]["name"], "count": (x.get("meta") or {}).get("numItems")}
                for x in r.json()]


async def read_items(collection_key: str | None = None, limit: int = 1000) -> list[dict]:
    path = f"/api/users/0/collections/{collection_key}/items/top" if collection_key else "/api/users/0/items/top"
    items: list[dict] = []
    async with httpx.AsyncClient(timeout=30) as c:
        # Like Zotero's web API, the local API returns at most 100 items per request.
        while len(items) < limit:
            r = await c.get(f"{ZOTERO}{path}", params={"limit": min(100, limit - len(items)), "start": len(items),
                                                        "format": "json"})
            if r.status_code != 200:
                raise RuntimeError("Could not read from Zotero. Is the local API turned on?")
            page = r.json()
            items += page
            try:
                total = int(r.headers.get("Total-Results") or 0)
            except ValueError:
                total = 0
            if not page or len(items) >= total:
                break
    out = []
    for it in items:
        d = it.get("data") or {}
        if d.get("itemType") in ("attachment", "note", "annotation"):
            continue
        authors = []
        for cr in d.get("creators") or []:
            name = cr.get("name") or " ".join(x for x in (cr.get("firstName"), cr.get("lastName")) if x)
            if name:
                authors.append({"name": name})
        extra = d.get("extra") or ""
        out.append(make_paper(
            source="zotero", title=d.get("title"), doi=d.get("DOI") or extra, abstract=d.get("abstractNote"),
            year=(re.search(r"\d{4}", d.get("date") or "") or [None])[0],
            venue=d.get("publicationTitle") or d.get("proceedingsTitle") or d.get("bookTitle"),
            authors=authors, url=d.get("url")))
    return out
