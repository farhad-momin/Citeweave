"""The common paper record and identifier helpers.

Every source converts its own format into the same plain dict:

{
  "id": "doi:10.1016/j.conbuildmat.2020.118000",   # stable key used everywhere
  "doi": "10.1016/j.conbuildmat.2020.118000",
  "title": "...", "abstract": "...", "year": 2020,
  "venue": "Construction and Building Materials",
  "authors": [{"name": "A. Rahman", "orcid": "0000-..."}],
  "cited_by_count": 12, "reference_count": 40,
  "oa_url": "https://...pdf", "url": "https://doi.org/...",
  "type": "article", "tldr": "", "topics": ["Concrete"],
  "ids": {"openalex": "W123", "s2": "abc", "arxiv": "2101.00001", "pmid": "...", "pmcid": "..."},
  "references": ["W1", ...]   # optional, OpenAlex ids of referenced works when known
  "sources": ["openalex"]
}
"""
from __future__ import annotations

import html
import re
import unicodedata
from typing import Any, Iterable

DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"<>]+", re.I)
ARXIV_RE = re.compile(r"(?:arxiv[:/ ]|abs/|pdf/)?(\d{4}\.\d{4,5})(v\d+)?", re.I)
OLD_ARXIV_RE = re.compile(r"(?:arxiv[:/ ]|abs/|pdf/)([a-z\-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?", re.I)
ORCID_RE = re.compile(r"(\d{4}-\d{4}-\d{4}-\d{3}[\dX])", re.I)
OPENALEX_RE = re.compile(r"\b(W\d{4,})\b")
PMID_RE = re.compile(r"^(?:pmid:)?\s*(\d{5,9})$", re.I)
PMCID_RE = re.compile(r"\b(PMC\d{5,9})\b", re.I)
S2_RE = re.compile(r"\b([0-9a-f]{40})\b")


def normalize_doi(value: str | None) -> str | None:
    if not value:
        return None
    m = DOI_RE.search(str(value))
    if not m:
        return None
    doi = m.group(0).strip().rstrip(".,;)]}")
    # remove trailing url fragments sometimes captured from pages
    doi = re.sub(r"(/abstract|/full|/pdf|/epdf|\.pdf)$", "", doi, flags=re.I)
    return doi.lower()


def parse_identifier(text: str) -> tuple[str, str] | None:
    """Turn any pasted identifier or URL into (kind, value).

    kinds: doi, arxiv, pmid, pmcid, openalex, s2, orcid
    """
    if not text:
        return None
    t = text.strip()
    doi = normalize_doi(t)
    if doi:
        # arXiv DOIs resolve better through the arXiv id
        m = re.match(r"10\.48550/arxiv\.(.+)", doi)
        if m:
            return ("arxiv", m.group(1))
        return ("doi", doi)
    if "arxiv" in t.lower() or re.fullmatch(r"\d{4}\.\d{4,5}(v\d+)?", t):
        m = ARXIV_RE.search(t) or OLD_ARXIV_RE.search(t)
        if m:
            return ("arxiv", m.group(1))
    m = PMCID_RE.search(t)
    if m:
        return ("pmcid", m.group(1).upper())
    if "pubmed" in t.lower():
        m = re.search(r"(\d{5,9})", t)
        if m:
            return ("pmid", m.group(1))
    m = PMID_RE.match(t)
    if m:
        return ("pmid", m.group(1))
    m = ORCID_RE.search(t)
    if m and ("orcid" in t.lower() or re.fullmatch(ORCID_RE.pattern, t, re.I)):
        return ("orcid", m.group(1).upper())
    m = OPENALEX_RE.search(t)
    if m and ("openalex" in t.lower() or re.fullmatch(r"W\d+", t)):
        return ("openalex", m.group(1))
    m = S2_RE.search(t)
    if m:
        return ("s2", m.group(1))
    return None


def paper_key(doi: str | None = None, ids: dict | None = None, title: str | None = None) -> str:
    ids = ids or {}
    if doi:
        return f"doi:{doi.lower()}"
    for kind in ("arxiv", "pmid", "openalex", "s2", "pmcid", "core", "scopus"):
        if ids.get(kind):
            return f"{kind}:{ids[kind]}"
    return "title:" + title_fingerprint(title or "untitled")


def title_fingerprint(title: str) -> str:
    t = unicodedata.normalize("NFKD", title or "").encode("ascii", "ignore").decode()
    t = re.sub(r"[^a-z0-9 ]", " ", t.lower())
    return " ".join(t.split())[:160]


def clean_text(text: Any) -> str:
    """Strip JATS/HTML tags and collapse whitespace."""
    if not text:
        return ""
    s = str(text)
    s = re.sub(r"<jats:title>.*?</jats:title>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"^\s*(abstract|summary)[:.\s]+", "", s, flags=re.I)
    return " ".join(s.split())


def abstract_from_inverted_index(inv: dict | None) -> str:
    if not inv:
        return ""
    positions: list[tuple[int, str]] = []
    for word, idxs in inv.items():
        for i in idxs:
            positions.append((i, word))
    positions.sort()
    return " ".join(w for _, w in positions)


def make_paper(
    *,
    source: str,
    title: str | None,
    doi: str | None = None,
    abstract: str | None = None,
    year: Any = None,
    venue: str | None = None,
    authors: Iterable[dict] | None = None,
    cited_by_count: Any = None,
    reference_count: Any = None,
    oa_url: str | None = None,
    url: str | None = None,
    type: str | None = None,
    tldr: str | None = None,
    topics: list[str] | None = None,
    ids: dict | None = None,
    references: list[str] | None = None,
) -> dict:
    doi = normalize_doi(doi)
    ids = {k: v for k, v in (ids or {}).items() if v}
    try:
        year = int(str(year)[:4]) if year else None
    except ValueError:
        year = None

    def to_int(v):
        try:
            return int(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    p = {
        "id": paper_key(doi, ids, title),
        "doi": doi,
        "title": clean_text(title) or "Untitled",
        "abstract": clean_text(abstract),
        "year": year,
        "venue": clean_text(venue),
        "authors": [a for a in (authors or []) if a.get("name")],
        "cited_by_count": to_int(cited_by_count),
        "reference_count": to_int(reference_count),
        "oa_url": oa_url or None,
        "url": url or (f"https://doi.org/{doi}" if doi else None),
        "type": type or None,
        "tldr": clean_text(tldr),
        "topics": topics or [],
        "ids": ids,
        "sources": [source],
    }
    if references is not None:
        p["references"] = references
    return p


def merge_papers(a: dict, b: dict) -> dict:
    """Combine two records of the same paper, keeping the richest value of each field."""
    out = dict(a)
    for k, v in b.items():
        if k == "ids":
            out["ids"] = {**(b.get("ids") or {}), **(a.get("ids") or {})}
        elif k == "sources":
            out["sources"] = list(dict.fromkeys((a.get("sources") or []) + (v or [])))
        elif k in ("cited_by_count", "reference_count"):
            vals = [x for x in (a.get(k), v) if isinstance(x, int)]
            out[k] = max(vals) if vals else None
        elif k == "abstract":
            if len(v or "") > len(a.get(k) or ""):
                out[k] = v
        elif out.get(k) in (None, "", [], {}, "Untitled") and v not in (None, "", [], {}):
            out[k] = v
    if out.get("doi") and not str(out.get("id", "")).startswith("doi:"):
        out["id"] = f"doi:{out['doi']}"
    return out


def dedupe(papers: Iterable[dict]) -> list[dict]:
    """Merge duplicates by DOI, external ids, then normalized title + year."""
    result: list[dict] = []
    index: dict[str, int] = {}

    def keys_for(p: dict) -> list[str]:
        ks = []
        if p.get("doi"):
            ks.append("doi:" + p["doi"])
        for kind, val in (p.get("ids") or {}).items():
            if val and kind in ("openalex", "s2", "arxiv", "pmid", "pmcid"):
                ks.append(f"{kind}:{val}")
        fp = title_fingerprint(p.get("title") or "")
        if len(fp) > 20:
            ks.append(f"t:{fp}:{p.get('year') or ''}")
        return ks

    for p in papers:
        ks = keys_for(p)
        hit = next((index[k] for k in ks if k in index), None)
        if hit is None:
            result.append(p)
            pos = len(result) - 1
        else:
            result[hit] = merge_papers(result[hit], p)
            pos = hit
        for k in keys_for(result[pos]):
            index[k] = pos
    return result


def author_names(p: dict, limit: int = 3) -> str:
    names = [a["name"] for a in p.get("authors") or []]
    if not names:
        return ""
    if len(names) > limit:
        return ", ".join(names[:limit]) + " et al."
    return ", ".join(names)


def title_similarity(a: str | None, b: str | None) -> float:
    """Jaccard overlap of the words in two titles, 0..1. Used to confirm a match is the same paper."""
    wa = set(re.findall(r"[a-z0-9]+", (a or "").lower()))
    wb = set(re.findall(r"[a-z0-9]+", (b or "").lower()))
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)
