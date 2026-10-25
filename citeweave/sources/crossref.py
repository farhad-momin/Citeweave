"""Crossref: the DOI registration agency's open metadata. No key needed.

Adding your email in Settings routes requests to Crossref's faster "polite" pool.
"""
from __future__ import annotations

from ..models import make_paper, normalize_doi, title_fingerprint
from ..net import get
from .base import Source, year_filter

BASE = "https://api.crossref.org"


def to_paper(m: dict) -> dict:
    def year_of(*keys):
        for k in keys:
            parts = ((m.get(k) or {}).get("date-parts") or [[None]])[0]
            if parts and parts[0]:
                return parts[0]
        return None

    authors = []
    for a in m.get("author") or []:
        name = " ".join(x for x in (a.get("given"), a.get("family")) if x) or a.get("name", "")
        orcid = (a.get("ORCID") or "").rstrip("/").split("/")[-1] or None
        authors.append({"name": name, "orcid": orcid})
    refs = [normalize_doi(r.get("DOI")) for r in m.get("reference") or [] if r.get("DOI")]
    p = make_paper(
        source="crossref",
        title=(m.get("title") or [""])[0],
        doi=m.get("DOI"),
        abstract=m.get("abstract"),
        year=year_of("issued", "published", "published-print", "published-online", "created"),
        venue=(m.get("container-title") or [""])[0],
        authors=authors,
        cited_by_count=m.get("is-referenced-by-count"),
        reference_count=m.get("references-count"),
        url=m.get("URL"),
        type=m.get("type"),
    )
    if refs:
        p["reference_dois"] = refs
    return p


class Crossref(Source):
    name = "crossref"
    label = "Crossref"
    homepage = "https://www.crossref.org"
    capabilities = {"search", "paper", "references", "verify"}

    def params(self, extra: dict | None = None) -> dict:
        p = dict(extra or {})
        if self.email():
            p["mailto"] = self.email()
        return p

    async def search(self, query, limit=25, filters=None):
        filt = []
        y0, y1 = year_filter(filters)
        if y0:
            filt.append(f"from-pub-date:{int(y0)}")
        if y1:
            filt.append(f"until-pub-date:{int(y1)}")
        params = {"query": query, "rows": min(limit, 100),
                  "select": "DOI,title,author,issued,published-print,published-online,container-title,abstract,"
                            "is-referenced-by-count,references-count,URL,type"}
        if filt:
            params["filter"] = ",".join(filt)
        sort = (filters or {}).get("sort")
        if sort == "citations":
            params["sort"], params["order"] = "is-referenced-by-count", "desc"
        elif sort == "newest":
            params["sort"], params["order"] = "published", "desc"
        data = await get(f"{BASE}/works", params=self.params(params), ttl=3600 * 12)
        return [to_paper(m) for m in ((data or {}).get("message") or {}).get("items", [])]

    async def paper(self, kind, value):
        if kind != "doi":
            return None
        data = await get(f"{BASE}/works/{value}", params=self.params(), ttl=86400 * 7)
        return to_paper(data["message"]) if data and data.get("message") else None

    async def references(self, paper, limit=200):
        if not paper.get("doi"):
            return []
        full = await self.paper("doi", paper["doi"])
        dois = (full or {}).get("reference_dois") or []
        out = []
        for d in dois[:min(limit, 60)]:
            p = await self.paper("doi", d)
            if p:
                out.append(p)
        return out

    async def verify(self, title: str, authors: str = "", year: int | None = None) -> dict | None:
        """Find the best matching real record for a title. Returns None when nothing matches well."""
        q = f"{title} {authors}".strip()
        data = await get(f"{BASE}/works", params=self.params({"query.bibliographic": q, "rows": 3}), ttl=86400 * 7)
        items = ((data or {}).get("message") or {}).get("items", [])
        want = set(title_fingerprint(title).split())
        best, best_score = None, 0.0
        for m in items:
            p = to_paper(m)
            got = set(title_fingerprint(p["title"]).split())
            if not want or not got:
                continue
            score = len(want & got) / max(len(want | got), 1)
            if year and p.get("year") and abs(p["year"] - int(year)) > 1:
                score -= 0.4  # a wrong year usually means a different record (repost, erratum)
            if score > best_score:
                best, best_score = p, score
        return best if best_score >= 0.7 else None
