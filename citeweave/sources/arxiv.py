"""arXiv preprints. No key. arXiv asks for at most one request every 3 seconds."""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET

from ..models import make_paper
from ..net import get
from .base import Source, year_filter

BASE = "https://export.arxiv.org/api/query"
NS = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}


def parse_feed(xml_text: str) -> list[dict]:
    out = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return out
    for e in root.findall("a:entry", NS):
        raw_id = (e.findtext("a:id", default="", namespaces=NS) or "").strip()
        m = re.search(r"abs/(.+?)(v\d+)?$", raw_id)
        if not m:
            continue
        arxiv_id = m.group(1)
        pdf = None
        for link in e.findall("a:link", NS):
            if link.get("title") == "pdf":
                pdf = link.get("href")
        doi = e.findtext("arxiv:doi", default=None, namespaces=NS)
        journal = e.findtext("arxiv:journal_ref", default="", namespaces=NS)
        cat = e.find("arxiv:primary_category", NS)
        out.append(make_paper(
            source="arxiv",
            title=e.findtext("a:title", default="", namespaces=NS),
            doi=doi,
            abstract=e.findtext("a:summary", default="", namespaces=NS),
            year=(e.findtext("a:published", default="", namespaces=NS) or "")[:4],
            venue=journal or "arXiv",
            authors=[{"name": (a.findtext("a:name", default="", namespaces=NS) or "").strip()}
                     for a in e.findall("a:author", NS)],
            oa_url=pdf or f"https://arxiv.org/pdf/{arxiv_id}",
            url=f"https://arxiv.org/abs/{arxiv_id}",
            type="preprint",
            topics=[cat.get("term")] if cat is not None and cat.get("term") else [],
            ids={"arxiv": arxiv_id},
        ))
    return out


class Arxiv(Source):
    name = "arxiv"
    label = "arXiv"
    homepage = "https://arxiv.org"
    capabilities = {"search", "paper"}

    async def search(self, query, limit=25, filters=None):
        terms = " AND ".join(f"all:{w}" for w in re.findall(r"[\w\-]+", query)[:12]) or f"all:{query}"
        y0, y1 = year_filter(filters)
        if y0 or y1:
            terms += f" AND submittedDate:[{y0 or 1990}01010000 TO {y1 or 2100}12312359]"
        text = await get(BASE, params={"search_query": terms, "start": 0, "max_results": min(limit, 100),
                                       "sortBy": "relevance"}, parse="text", ttl=3600 * 12)
        return parse_feed(text or "")

    async def paper(self, kind, value):
        if kind != "arxiv":
            return None
        text = await get(BASE, params={"id_list": value}, parse="text", ttl=86400 * 7)
        papers = parse_feed(text or "")
        return papers[0] if papers else None
