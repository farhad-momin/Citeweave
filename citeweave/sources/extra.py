"""Smaller sources: Unpaywall, ORCID, CORE and Scopus."""
from __future__ import annotations

from ..models import make_paper, normalize_doi
from ..net import get
from .base import Source, year_filter


class Unpaywall(Source):
    """Finds legal open access copies of a DOI. Unpaywall asks for an email with each request."""
    name = "unpaywall"
    label = "Unpaywall"
    homepage = "https://unpaywall.org"
    capabilities = {"oa_link"}

    def ready(self):
        if not self.enabled():
            return False, "Unpaywall is turned off in Settings"
        if not self.email():
            return False, "Unpaywall needs your email address (Settings, General)"
        return True, ""

    async def oa_link(self, doi: str) -> dict | None:
        ok, _ = self.ready()
        if not ok or not doi:
            return None
        data = await get(f"https://api.unpaywall.org/v2/{doi}", params={"email": self.email()}, ttl=86400 * 7)
        if not data:
            return None
        best = data.get("best_oa_location") or {}
        return {
            "pdf": best.get("url_for_pdf"),
            "page": best.get("url_for_landing_page") or best.get("url"),
            "version": best.get("version"),
            "license": best.get("license"),
            "status": data.get("oa_status"),
        }


class Orcid(Source):
    """Public ORCID records. Reading public data needs no key."""
    name = "orcid"
    label = "ORCID"
    homepage = "https://orcid.org"
    capabilities = {"author"}

    def enabled(self) -> bool:
        return True

    async def works(self, orcid: str) -> tuple[dict | None, list[dict]]:
        headers = {"Accept": "application/json"}
        person = await get(f"https://pub.orcid.org/v3.0/{orcid}/person", headers=headers, ttl=86400)
        data = await get(f"https://pub.orcid.org/v3.0/{orcid}/works", headers=headers, ttl=86400)
        if data is None and person is None:
            return None, []
        name = ""
        if person:
            n = person.get("name") or {}
            given = ((n.get("given-names") or {}) or {}).get("value", "")
            family = ((n.get("family-name") or {}) or {}).get("value", "")
            name = f"{given} {family}".strip()
        works = []
        for g in (data or {}).get("group", []):
            s = (g.get("work-summary") or [{}])[0]
            ext = ((s.get("external-ids") or {}).get("external-id") or [])
            doi = None
            ids = {}
            for e in ext:
                if (e.get("external-id-relationship") or "self").lower() != "self":
                    continue  # "part-of" ids belong to the book or journal, not this work
                t = (e.get("external-id-type") or "").lower()
                v = e.get("external-id-value")
                if t == "doi":
                    doi = normalize_doi(v)
                elif t in ("arxiv", "pmid", "pmc"):
                    ids["pmcid" if t == "pmc" else t] = v
            title = (((s.get("title") or {}).get("title")) or {}).get("value", "")
            year = (((s.get("publication-date") or {}).get("year")) or {}).get("value")
            venue = ((s.get("journal-title") or {}) or {}).get("value", "")
            works.append(make_paper(source="orcid", title=title, doi=doi, year=year, venue=venue,
                                    type=s.get("type"), ids=ids))
        return {"name": name, "orcid": orcid, "works_count": len(works)}, works


class Core(Source):
    """CORE aggregates open access research outputs from repositories. Free key required."""
    name = "core"
    label = "CORE"
    homepage = "https://core.ac.uk"
    key_required = True
    key_help = "Register for a free key at core.ac.uk/services/api."
    capabilities = {"search"}

    async def search(self, query, limit=25, filters=None):
        q = query
        y0, y1 = year_filter(filters)
        if y0:
            q += f" AND yearPublished>={int(y0)}"
        if y1:
            q += f" AND yearPublished<={int(y1)}"
        data = await get("https://api.core.ac.uk/v3/search/works", params={"q": q, "limit": min(limit, 100)},
                         headers={"Authorization": f"Bearer {self.key()}"}, ttl=3600 * 12)
        out = []
        for r in (data or {}).get("results", []):
            out.append(make_paper(
                source="core", title=r.get("title"), doi=r.get("doi"), abstract=r.get("abstract"),
                year=r.get("yearPublished"), venue=(r.get("publisher") or ""),
                authors=[{"name": a.get("name", "")} for a in r.get("authors") or []],
                cited_by_count=r.get("citationCount"), oa_url=r.get("downloadUrl"),
                url=(r.get("links") or [{}])[0].get("url") if r.get("links") else None,
                ids={"core": str(r.get("id")) if r.get("id") else None},
            ))
        return out


class Scopus(Source):
    """Elsevier Scopus. Needs your own key, and usually your institution's network or an institution token."""
    name = "scopus"
    label = "Scopus"
    homepage = "https://dev.elsevier.com"
    key_required = True
    key_help = "Get a key at dev.elsevier.com. Full access usually requires your institution's network."
    capabilities = {"search", "author"}

    def headers(self) -> dict:
        h = {"X-ELS-APIKey": self.key(), "Accept": "application/json"}
        token = (self.cfg().get("insttoken") or "").strip()
        if token:
            h["X-ELS-Insttoken"] = token
        return h

    @staticmethod
    def to_paper(e: dict) -> dict:
        return make_paper(
            source="scopus", title=e.get("dc:title"), doi=e.get("prism:doi"),
            abstract=e.get("dc:description"), year=(e.get("prism:coverDate") or "")[:4],
            venue=e.get("prism:publicationName"),
            authors=[{"name": e.get("dc:creator")}] if e.get("dc:creator") else [],
            cited_by_count=e.get("citedby-count"),
            ids={"scopus": (e.get("dc:identifier") or "").replace("SCOPUS_ID:", "") or None,
                 "pmid": e.get("pubmed-id")},
        )

    async def _search(self, query: str, limit: int) -> list[dict]:
        # The standard view returns at most 25 records per request, so page with `start`.
        out: list[dict] = []
        start = 0
        while len(out) < limit:
            data = await get("https://api.elsevier.com/content/search/scopus",
                             params={"query": query, "count": min(limit - len(out), 25), "start": start},
                             headers=self.headers(), ttl=3600 * 12)
            results = (data or {}).get("search-results") or {}
            entries = [e for e in results.get("entry") or [] if not e.get("error")]
            out += [self.to_paper(e) for e in entries]
            start += len(entries)
            try:
                total = int(results.get("opensearch:totalResults") or 0)
            except (TypeError, ValueError):
                total = 0
            if not entries or start >= total:
                break
        return out[:limit]

    async def search(self, query, limit=25, filters=None):
        q = f"TITLE-ABS-KEY({query})"
        y0, y1 = year_filter(filters)
        if y0:
            q += f" AND PUBYEAR > {int(y0) - 1}"
        if y1:
            q += f" AND PUBYEAR < {int(y1) + 1}"
        return await self._search(q, limit)

    async def author_works(self, author_id: str, limit: int = 200):
        works = await self._search(f"AU-ID({author_id})", limit)
        return {"scopus": author_id, "works_count": len(works)}, works
