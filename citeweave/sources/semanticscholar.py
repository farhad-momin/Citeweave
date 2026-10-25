"""Semantic Scholar Academic Graph (Allen Institute for AI).

Free. Without a key, requests share a public pool that can be busy.
A free personal key (request at semanticscholar.org/product/api) gives a steady rate.
Provides short TLDR summaries and a recommendations endpoint.
"""
from __future__ import annotations

from ..models import make_paper
from ..net import get, post
from .base import Source, year_filter

GRAPH = "https://api.semanticscholar.org/graph/v1"
RECS = "https://api.semanticscholar.org/recommendations/v1"
FIELDS = ("title,abstract,year,venue,authors,citationCount,referenceCount,externalIds,"
          "openAccessPdf,tldr,url,publicationTypes,fieldsOfStudy")
FIELDS_LITE = "title,abstract,year,venue,authors,citationCount,referenceCount,externalIds,openAccessPdf,url"


def to_paper(p: dict) -> dict | None:
    if not p or not p.get("title"):
        return None
    ext = p.get("externalIds") or {}
    oa = p.get("openAccessPdf") or {}
    return make_paper(
        source="semanticscholar",
        title=p.get("title"),
        doi=ext.get("DOI"),
        abstract=p.get("abstract"),
        year=p.get("year"),
        venue=p.get("venue"),
        authors=[{"name": a.get("name", ""), "s2": a.get("authorId")} for a in p.get("authors") or []],
        cited_by_count=p.get("citationCount"),
        reference_count=p.get("referenceCount"),
        oa_url=oa.get("url") or None,
        url=p.get("url"),
        type=(p.get("publicationTypes") or [None])[0],
        tldr=(p.get("tldr") or {}).get("text") if isinstance(p.get("tldr"), dict) else None,
        topics=p.get("fieldsOfStudy") or [],
        ids={
            "s2": p.get("paperId"),
            "arxiv": ext.get("ArXiv"),
            "pmid": ext.get("PubMed"),
            "pmcid": ("PMC" + str(ext["PubMedCentral"])) if ext.get("PubMedCentral") else None,
            "corpus": ext.get("CorpusId"),
        },
    )


class SemanticScholar(Source):
    name = "semanticscholar"
    label = "Semantic Scholar"
    homepage = "https://www.semanticscholar.org"
    key_help = "Optional. Request a free key at semanticscholar.org/product/api for a steady rate."
    capabilities = {"search", "paper", "references", "citations", "recommend", "author"}

    def headers(self) -> dict:
        return {"x-api-key": self.key()} if self.key() else {}

    @staticmethod
    def s2_id(kind: str, value: str) -> str | None:
        return {
            "doi": f"DOI:{value}",
            "arxiv": f"ARXIV:{value}",
            "pmid": f"PMID:{value}",
            "pmcid": f"PMCID:{value.replace('PMC', '')}",
            "s2": value,
        }.get(kind)

    def id_for(self, paper: dict) -> str | None:
        ids = paper.get("ids") or {}
        if ids.get("s2"):
            return ids["s2"]
        if paper.get("doi"):
            return f"DOI:{paper['doi']}"
        if ids.get("arxiv"):
            return f"ARXIV:{ids['arxiv']}"
        if ids.get("pmid"):
            return f"PMID:{ids['pmid']}"
        return None

    async def search(self, query, limit=25, filters=None):
        params = {"query": query, "limit": min(limit, 100), "fields": FIELDS}
        y0, y1 = year_filter(filters)
        if y0 or y1:
            params["year"] = f"{y0 or ''}-{y1 or ''}"
        data = await get(f"{GRAPH}/paper/search", params=params, headers=self.headers(), ttl=3600 * 12)
        papers = [x for x in (to_paper(p) for p in (data or {}).get("data", [])) if x]
        if (filters or {}).get("oa_only"):
            papers = [p for p in papers if p.get("oa_url")]
        return papers

    async def paper(self, kind, value):
        sid = self.s2_id(kind, value)
        if not sid:
            return None
        data = await get(f"{GRAPH}/paper/{sid}", params={"fields": FIELDS}, headers=self.headers(), ttl=86400 * 7)
        return to_paper(data) if data else None

    async def batch(self, ids: list[str]) -> list[dict]:
        out: list[dict] = []
        ids = [i for i in dict.fromkeys(ids) if i]
        for i in range(0, len(ids), 400):
            data = await post(f"{GRAPH}/paper/batch", params={"fields": FIELDS_LITE},
                              json_body={"ids": ids[i:i + 400]}, headers=self.headers(), ttl=86400 * 7)
            out += [x for x in (to_paper(p) for p in (data or []) if p) if x]
        return out

    async def _edges(self, paper: dict, kind: str, limit: int) -> list[dict]:
        sid = self.id_for(paper)
        if not sid:
            return []
        key = "citedPaper" if kind == "references" else "citingPaper"
        out: list[dict] = []
        offset = 0
        while len(out) < limit:
            page = min(100, limit - len(out))
            data = await get(f"{GRAPH}/paper/{sid}/{kind}",
                             params={"fields": FIELDS_LITE, "limit": page, "offset": offset},
                             headers=self.headers(), ttl=86400)
            rows = (data or {}).get("data") or []
            out += [x for x in (to_paper(r.get(key) or {}) for r in rows) if x]
            if not data or data.get("next") is None or not rows:
                break
            offset = data["next"]
        return out

    async def references(self, paper, limit=200):
        return await self._edges(paper, "references", limit)

    async def citations(self, paper, limit=200):
        return await self._edges(paper, "citations", limit)

    async def recommend(self, papers: list[dict], negative: list[dict] | None = None, limit: int = 30):
        pos = [i for i in (self.id_for(p) for p in papers) if i]
        neg = [i for i in (self.id_for(p) for p in negative or []) if i]
        if not pos:
            return []
        data = await post(f"{RECS}/papers", params={"fields": FIELDS_LITE, "limit": min(limit, 100)},
                          json_body={"positivePaperIds": pos[:100], "negativePaperIds": neg[:100]},
                          headers=self.headers(), ttl=86400)
        return [x for x in (to_paper(p) for p in (data or {}).get("recommendedPapers", [])) if x]

    async def author_works(self, author_id: str, limit: int = 500):
        info = await get(f"{GRAPH}/author/{author_id}",
                         params={"fields": "name,paperCount,citationCount,hIndex,affiliations"},
                         headers=self.headers(), ttl=86400)
        if not info:
            return None, []
        data = await get(f"{GRAPH}/author/{author_id}/papers", params={"fields": FIELDS_LITE, "limit": min(limit, 1000)},
                         headers=self.headers(), ttl=86400)
        works = [x for x in (to_paper(p) for p in (data or {}).get("data", [])) if x]
        return {
            "name": info.get("name"),
            "s2": author_id,
            "works_count": info.get("paperCount"),
            "cited_by_count": info.get("citationCount"),
            "h_index": info.get("hIndex"),
            "institution": ", ".join(info.get("affiliations") or []),
        }, works
