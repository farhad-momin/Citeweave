"""Europe PMC: life science literature including PubMed, preprints and open full text. No key."""
from __future__ import annotations

from ..models import make_paper
from ..net import get
from .base import Source, year_filter

BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest"


def to_paper(r: dict) -> dict:
    oa = None
    for u in ((r.get("fullTextUrlList") or {}).get("fullTextUrl") or []):
        if u.get("documentStyle") == "pdf" and u.get("availabilityCode") in ("OA", "F"):
            oa = u.get("url")
            break
    authors = [{"name": a.get("fullName", ""), "orcid": (a.get("authorId") or {}).get("value")
                if (a.get("authorId") or {}).get("type") == "ORCID" else None}
               for a in ((r.get("authorList") or {}).get("author") or [])]
    if not authors and r.get("authorString"):
        authors = [{"name": n.strip()} for n in r["authorString"].rstrip(".").split(",") if n.strip()]
    pmcid = r.get("pmcid")
    journal_info = r.get("journalInfo") or {}
    # Records from the PMC source often lack pubYear, so fall back to the other dates.
    year = (r.get("pubYear") or journal_info.get("yearOfPublication")
            or (r.get("firstPublicationDate") or "")[:4] or (r.get("electronicPublicationDate") or "")[:4] or None)
    if not oa and pmcid and r.get("isOpenAccess") == "Y":
        oa = f"https://europepmc.org/articles/{pmcid}?pdf=render"
    return make_paper(
        source="europepmc",
        title=r.get("title"),
        doi=r.get("doi"),
        abstract=r.get("abstractText"),
        year=year,
        venue=r.get("journalTitle") or (journal_info.get("journal") or {}).get("title"),
        authors=authors,
        cited_by_count=r.get("citedByCount"),
        oa_url=oa,
        url=f"https://europepmc.org/article/{r.get('source', 'MED')}/{r.get('id')}" if r.get("id") else None,
        type=((r.get("pubTypeList") or {}).get("pubType") or [None])[0],
        ids={"pmid": r.get("pmid"), "pmcid": pmcid},
    )


class EuropePMC(Source):
    name = "europepmc"
    label = "Europe PMC"
    homepage = "https://europepmc.org"
    capabilities = {"search", "paper"}

    async def search(self, query, limit=25, filters=None):
        # group the user's query so the filters below apply to all of it (AND binds tighter than OR)
        q = f"({query})"
        y0, y1 = year_filter(filters)
        if y0 or y1:
            q += f" AND (PUB_YEAR:[{y0 or 1800} TO {y1 or 2100}])"
        if (filters or {}).get("oa_only"):
            q += " AND OPEN_ACCESS:y"
        sort = (filters or {}).get("sort")
        params = {"query": q, "format": "json", "resultType": "core", "pageSize": min(limit, 100)}
        if sort == "citations":
            params["sort"] = "CITED desc"
        elif sort == "newest":
            params["sort"] = "P_PDATE_D desc"
        data = await get(f"{BASE}/search", params=params, ttl=3600 * 12)
        return [to_paper(r) for r in ((data or {}).get("resultList") or {}).get("result", [])]

    async def paper(self, kind, value):
        field = {"doi": "DOI", "pmid": "EXT_ID", "pmcid": "PMCID"}.get(kind)
        if not field:
            return None
        q = f'{field}:"{value}"' + (" AND SRC:MED" if kind == "pmid" else "")
        data = await get(f"{BASE}/search", params={"query": q, "format": "json", "resultType": "core",
                                                   "pageSize": 1}, ttl=86400 * 7)
        rows = ((data or {}).get("resultList") or {}).get("result", [])
        return to_paper(rows[0]) if rows else None
