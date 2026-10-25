"""OpenAlex: open catalogue of scholarly works (CC0 data).

Works without a key on a small daily allowance. A free key from openalex.org
raises it. Lookups by id or DOI are the cheapest calls, so the app prefers them.
"""
from __future__ import annotations

from ..models import abstract_from_inverted_index, make_paper
from ..net import get
from .base import Source, year_filter

BASE = "https://api.openalex.org"
SELECT = ",".join([
    "id", "doi", "display_name", "publication_year", "authorships", "primary_location",
    "best_oa_location", "open_access", "cited_by_count", "referenced_works_count",
    "abstract_inverted_index", "ids", "type", "referenced_works", "topics",
])


def short_id(url_or_id: str | None) -> str | None:
    if not url_or_id:
        return None
    return str(url_or_id).rstrip("/").split("/")[-1]


def to_paper(w: dict) -> dict:
    ids = w.get("ids") or {}
    loc = w.get("primary_location") or {}
    src = loc.get("source") or {}
    best = w.get("best_oa_location") or {}
    oa_url = best.get("pdf_url") or (w.get("open_access") or {}).get("oa_url")
    authors = []
    for a in w.get("authorships") or []:
        au = a.get("author") or {}
        authors.append({
            "name": au.get("display_name") or a.get("raw_author_name") or "",
            "orcid": short_id(au.get("orcid")),
            "openalex": short_id(au.get("id")),
        })
    pmid = short_id(ids.get("pmid"))
    pmcid = short_id(ids.get("pmcid"))
    if pmcid and pmcid.isdigit():  # OpenAlex gives .../pmc/articles/5815332; elsewhere it is PMC5815332
        pmcid = "PMC" + pmcid
    return make_paper(
        source="openalex",
        title=w.get("display_name") or w.get("title"),
        doi=w.get("doi"),
        abstract=abstract_from_inverted_index(w.get("abstract_inverted_index")),
        year=w.get("publication_year"),
        venue=src.get("display_name"),
        authors=authors,
        cited_by_count=w.get("cited_by_count"),
        reference_count=w.get("referenced_works_count"),
        oa_url=oa_url,
        url=loc.get("landing_page_url"),
        type=w.get("type"),
        topics=[t.get("display_name") for t in (w.get("topics") or [])[:3] if t.get("display_name")],
        ids={"openalex": short_id(w.get("id")), "pmid": pmid, "pmcid": pmcid},
        references=[short_id(r) for r in w.get("referenced_works") or []],
    )


class OpenAlex(Source):
    name = "openalex"
    label = "OpenAlex"
    homepage = "https://openalex.org"
    key_help = "Optional. A free key from openalex.org (Settings, API) gives a 10x larger daily allowance."
    capabilities = {"search", "paper", "references", "citations", "author", "related"}

    def params(self, extra: dict | None = None) -> dict:
        p = dict(extra or {})
        if self.key():
            p["api_key"] = self.key()
        if self.email():
            p["mailto"] = self.email()
        return p

    async def _works(self, params: dict, ttl: float = 86400) -> list[dict]:
        data = await get(f"{BASE}/works", params=self.params({"select": SELECT, **params}), ttl=ttl)
        return [to_paper(w) for w in (data or {}).get("results", [])]

    async def search(self, query, limit=25, filters=None):
        filt = []
        y0, y1 = year_filter(filters)
        if y0:
            filt.append(f"from_publication_date:{int(y0)}-01-01")
        if y1:
            filt.append(f"to_publication_date:{int(y1)}-12-31")
        if (filters or {}).get("oa_only"):
            filt.append("is_oa:true")
        params = {"search": query, "per_page": min(limit, 100)}
        if filt:
            params["filter"] = ",".join(filt)
        sort = (filters or {}).get("sort")
        if sort == "citations":
            params["sort"] = "cited_by_count:desc"
        elif sort == "newest":
            params["sort"] = "publication_date:desc"
        return await self._works(params, ttl=3600 * 12)

    async def paper(self, kind, value):
        path = {
            "doi": f"doi:{value}",
            "openalex": value,
            "pmid": f"pmid:{value}",
            "pmcid": f"pmcid:{value}",
            "arxiv": f"doi:10.48550/arxiv.{value}",
        }.get(kind)
        if not path:
            return None
        data = await get(f"{BASE}/works/{path}", params=self.params({"select": SELECT}), ttl=86400 * 7)
        return to_paper(data) if data else None

    async def batch(self, openalex_ids: list[str]) -> list[dict]:
        """Fetch many works by OpenAlex id, 50 per request."""
        out: list[dict] = []
        ids = [i for i in dict.fromkeys(openalex_ids) if i]
        for i in range(0, len(ids), 50):
            chunk = ids[i:i + 50]
            out += await self._works({"filter": "ids.openalex:" + "|".join(chunk), "per_page": 50}, ttl=86400 * 7)
        return out

    async def batch_dois(self, dois: list[str]) -> list[dict]:
        out: list[dict] = []
        ids = [d for d in dict.fromkeys(dois) if d]
        for i in range(0, len(ids), 50):
            chunk = ids[i:i + 50]
            out += await self._works({"filter": "doi:" + "|".join(chunk), "per_page": 50}, ttl=86400 * 7)
        return out

    async def _ensure(self, paper: dict) -> dict | None:
        if paper.get("ids", {}).get("openalex"):
            return paper
        if paper.get("doi"):
            return await self.paper("doi", paper["doi"])
        return None

    async def references(self, paper, limit=200):
        p = await self._ensure(paper)
        if not p:
            return []
        refs = p.get("references")
        if refs is None:
            full = await self.paper("openalex", p["ids"]["openalex"])
            refs = (full or {}).get("references") or []
        return await self.batch(refs[:limit])

    async def citations(self, paper, limit=200, since: str | None = None):
        p = await self._ensure(paper)
        if not p:
            return []
        filt = f"cites:{p['ids']['openalex']}"
        if since:
            filt += f",from_publication_date:{since}"
        out: list[dict] = []
        cursor = "*"
        while len(out) < limit and cursor:
            data = await get(f"{BASE}/works", params=self.params({
                "select": SELECT, "filter": filt, "per_page": min(100, limit),
                "sort": "cited_by_count:desc", "cursor": cursor,
            }), ttl=86400)
            if not data:
                break
            out += [to_paper(w) for w in data.get("results", [])]
            cursor = (data.get("meta") or {}).get("next_cursor")
            if not data.get("results"):
                break
        return out[:limit]

    async def cited_by_any(self, openalex_ids: list[str], since: str, limit: int = 200) -> list[dict]:
        """Works citing any of the given ids, published on or after `since` (YYYY-MM-DD)."""
        out: list[dict] = []
        ids = [i for i in openalex_ids if i]
        for i in range(0, len(ids), 50):
            filt = "cites:" + "|".join(ids[i:i + 50]) + f",from_publication_date:{since}"
            out += await self._works({"filter": filt, "per_page": 100, "sort": "publication_date:desc"}, ttl=3600)
        return out[:limit]

    async def related(self, paper, limit=20):
        p = await self._ensure(paper)
        if not p:
            return []
        data = await get(f"{BASE}/works/{p['ids']['openalex']}", params=self.params({"select": "related_works"}),
                         ttl=86400 * 7)
        rel = [short_id(r) for r in (data or {}).get("related_works", [])]
        return await self.batch(rel[:limit])

    async def author_works(self, orcid: str | None = None, author_id: str | None = None, limit: int = 500):
        if orcid and not author_id:
            a = await get(f"{BASE}/authors/orcid:{orcid}", params=self.params(), ttl=86400)
            if not a:
                return None, []
            author_id = short_id(a.get("id"))
            author = a
        else:
            author = await get(f"{BASE}/authors/{author_id}", params=self.params(), ttl=86400)
        if not author:
            return None, []
        out: list[dict] = []
        cursor = "*"
        while cursor and len(out) < limit:
            data = await get(f"{BASE}/works", params=self.params({
                "select": SELECT, "filter": f"author.id:{author_id}", "per_page": 100,
                "sort": "publication_year:desc", "cursor": cursor,
            }), ttl=86400)
            if not data or not data.get("results"):
                break
            out += [to_paper(w) for w in data["results"]]
            cursor = (data.get("meta") or {}).get("next_cursor")
        info = {
            "name": author.get("display_name"),
            "openalex": short_id(author.get("id")),
            "orcid": short_id(author.get("orcid")),
            "works_count": author.get("works_count"),
            "cited_by_count": author.get("cited_by_count"),
            "h_index": (author.get("summary_stats") or {}).get("h_index"),
            "institution": ((author.get("last_known_institutions") or [{}])[0] or {}).get("display_name"),
        }
        return info, out

    async def autocomplete(self, q: str) -> list[dict]:
        data = await get(f"{BASE}/autocomplete/works", params=self.params({"q": q}), ttl=3600)
        return [{"title": r.get("display_name"), "hint": r.get("hint"), "openalex": short_id(r.get("id"))}
                for r in (data or {}).get("results", [])]
