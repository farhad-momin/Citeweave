"""Lightweight relevance ranking (BM25) that runs instantly on any computer, no AI needed."""
from __future__ import annotations

import math
import re
from collections import Counter

STOP = set("""a an and are as at be been being but by can could did do does for from had has have how
if in into is it its may might of on or our out should so such than that the their them then there these
they this those to under up via was we were what when where which while who whom why will with within
would you your study studies paper research using use used based effect effects analysis results result
between among also more most other some about over""".split())


def tokens(text: str) -> list[str]:
    words = re.findall(r"[a-z0-9][a-z0-9\-]+", (text or "").lower())
    out = []
    for w in words:
        if w in STOP or len(w) < 2:
            continue
        # tiny stemmer: plural and common suffixes
        for suf in ("ies", "es", "s"):
            if w.endswith(suf) and len(w) > len(suf) + 3:
                w = w[: -len(suf)] + ("y" if suf == "ies" else "")
                break
        out.append(w)
    return out


def bm25(query: str, docs: list[str], k1: float = 1.4, b: float = 0.75) -> list[float]:
    q = tokens(query)
    if not q or not docs:
        return [0.0] * len(docs)
    toks = [tokens(d) for d in docs]
    n = len(docs)
    avgdl = sum(len(t) for t in toks) / n or 1
    df = Counter()
    for t in toks:
        df.update(set(t))
    scores = []
    for t in toks:
        tf = Counter(t)
        dl = len(t) or 1
        s = 0.0
        for term in q:
            if term not in tf:
                continue
            idf = math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5))
            s += idf * tf[term] * (k1 + 1) / (tf[term] + k1 * (1 - b + b * dl / avgdl))
        scores.append(s)
    return scores


def rank_papers(query: str, papers: list[dict]) -> list[dict]:
    """Blend text relevance with the source's own order and a small citation signal."""
    if not papers:
        return []
    docs = [f"{p.get('title', '')} {p.get('title', '')} {p.get('abstract', '')}" for p in papers]
    rel = bm25(query, docs)
    top = max(rel) or 1
    out = []
    for i, (p, r) in enumerate(zip(papers, rel)):
        order = 1 - i / max(len(papers), 1)
        cites = math.log1p(p.get("cited_by_count") or 0) / 10
        q = dict(p)
        q["relevance"] = round(0.65 * r / top + 0.25 * order + 0.10 * min(cites, 1), 4)
        out.append(q)
    out.sort(key=lambda x: x["relevance"], reverse=True)
    return out


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", text or "")
    return [p.strip() for p in parts if len(p.strip()) > 30]


RESULT_WORDS = re.compile(r"\b(increas|decreas|improv|reduc|higher|lower|significant|found|show|result|"
                          r"conclud|suggest|indicat|outperform|associated|effective)\w*", re.I)


def key_sentence(query: str, text: str) -> str:
    """The abstract sentence that best answers the query, preferring sentences that report findings."""
    sents = split_sentences(text)
    if not sents:
        return ""
    scores = bm25(query, sents)
    top = max(scores) or 1
    scores = [sc / top + (0.35 if RESULT_WORDS.search(st) else 0) + (0.15 if re.search(r"\d", st) else 0)
              if sc > 0 else 0 for sc, st in zip(scores, sents)]
    best = max(range(len(sents)), key=lambda i: scores[i])
    return sents[best] if scores[best] > 0 else sents[0]
