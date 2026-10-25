"""PubMed through NCBI E-utilities. No key needed; a free NCBI key raises the rate limit."""
from __future__ import annotations

import xml.etree.ElementTree as ET

from ..models import make_paper
from ..net import get
from .base import Source, year_filter

BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"


def parse_efetch(xml_text: str) -> list[dict]:
    out = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return out
    for art in root.findall(".//PubmedArticle"):
        med = art.find("MedlineCitation")
        if med is None:
            continue
        a = med.find("Article")
        if a is None:
            continue
        title = "".join(a.find("ArticleTitle").itertext()) if a.find("ArticleTitle") is not None else ""
        abstract = " ".join("".join(t.itertext()) for t in a.findall("Abstract/AbstractText"))
        journal = a.findtext("Journal/Title", default="")
        year = a.findtext("Journal/JournalIssue/PubDate/Year") or \
            (a.findtext("Journal/JournalIssue/PubDate/MedlineDate") or "")[:4]
        authors = []
        for au in a.findall("AuthorList/Author"):
            name = " ".join(x for x in (au.findtext("ForeName"), au.findtext("LastName")) if x) or \
                au.findtext("CollectiveName", default="")
            orcid = None
            for ident in au.findall("Identifier"):
                if ident.get("Source") == "ORCID" and ident.text:
                    orcid = ident.text.rstrip("/").split("/")[-1]
            authors.append({"name": name, "orcid": orcid})
        ids = {"pmid": med.findtext("PMID")}
        doi = None
        for aid in art.findall("PubmedData/ArticleIdList/ArticleId"):
            if aid.get("IdType") == "doi":
                doi = aid.text
            elif aid.get("IdType") == "pmc":
                ids["pmcid"] = aid.text
        out.append(make_paper(
            source="pubmed", title=title, doi=doi, abstract=abstract, year=year, venue=journal,
            authors=authors, url=f"https://pubmed.ncbi.nlm.nih.gov/{ids['pmid']}/", ids=ids,
            oa_url=f"https://www.ncbi.nlm.nih.gov/pmc/articles/{ids['pmcid']}/pdf/" if ids.get("pmcid") else None,
        ))
    return out


class PubMed(Source):
    name = "pubmed"
    label = "PubMed"
    homepage = "https://pubmed.ncbi.nlm.nih.gov"
    key_help = "Optional. A free NCBI API key raises the request rate."
    capabilities = {"search", "paper"}

    def params(self, extra: dict) -> dict:
        p = {"tool": "citeweave", **extra}
        if self.email():
            p["email"] = self.email()
        if self.key():
            p["api_key"] = self.key()
        return p

    async def fetch(self, pmids: list[str]) -> list[dict]:
        if not pmids:
            return []
        text = await get(f"{BASE}/efetch.fcgi", params=self.params({"db": "pubmed", "id": ",".join(pmids),
                                                                   "retmode": "xml"}), parse="text", ttl=86400 * 7)
        return parse_efetch(text or "")

    async def search(self, query, limit=25, filters=None):
        term = query
        y0, y1 = year_filter(filters)
        if y0 or y1:
            term += f" AND ({y0 or 1800}:{y1 or 3000}[pdat])"
        if (filters or {}).get("oa_only"):
            term += " AND free full text[sb]"
        sort = {"newest": "pub_date"}.get((filters or {}).get("sort") or "", "relevance")
        data = await get(f"{BASE}/esearch.fcgi", params=self.params({
            "db": "pubmed", "term": term, "retmode": "json", "retmax": min(limit, 100), "sort": sort}),
            ttl=3600 * 12)
        ids = ((data or {}).get("esearchresult") or {}).get("idlist", [])
        return await self.fetch(ids)

    async def paper(self, kind, value):
        if kind != "pmid":
            return None
        rows = await self.fetch([value])
        return rows[0] if rows else None
