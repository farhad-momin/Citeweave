"""Research tasks that can use a language model.

Every task has a version that works without AI, so the app stays useful at zero cost:
  ask        without AI: ranked papers plus the most relevant sentence of each abstract
  summarize  without AI: the source's own short summary, or the key sentences
  extract    needs AI (the table stays empty without it)
  suggest    needs AI; every suggestion is checked against Crossref and dropped if not found
"""
from __future__ import annotations

import asyncio
import json
from typing import Callable

from .. import aggregator
from .. import sources as S
from ..fulltext import get_text
from ..models import dedupe, title_similarity
from ..rank import key_sentence, rank_papers, split_sentences
from .providers import AIError, chat, is_enabled, parse_json

GROUNDING = (
    "You are a careful research assistant. Use only the paper excerpts provided. "
    "Do not invent findings, numbers or references. If the excerpts do not answer the question, say so plainly."
)


async def rewrite_query(question: str) -> str:
    if not is_enabled():
        return question
    try:
        out = await chat(
            "Turn a research question into a short keyword search query for a scholarly database. "
            "Reply with the query only, 3 to 10 words, no quotes, no boolean operators.",
            question, max_tokens=40)
        lines = out.strip().strip('"').splitlines()
        out = lines[0].strip()[:200] if lines else ""
        return out or question
    except AIError:
        return question


def _excerpt(p: dict, n: int) -> str:
    authors = ", ".join(a["name"] for a in (p.get("authors") or [])[:3])
    return (f"[{n}] {p.get('title')} ({authors}{', ' if authors else ''}{p.get('year') or 'n.d.'}). "
            f"{p.get('venue') or ''}\n{(p.get('abstract') or p.get('tldr') or '')[:1800]}")


async def ask(question: str, *, limit: int = 8, source: str = "auto", filters: dict | None = None,
              use_ai: bool = True, progress: Callable[[str, float], None] | None = None) -> dict:
    progress = progress or (lambda m, f: None)
    ai_on = use_ai and is_enabled()
    progress("Preparing search", 0.05)
    query = await rewrite_query(question) if ai_on else question
    progress("Searching", 0.2)
    found = await aggregator.search(query, source=source, limit=30, filters=filters)
    papers = [p for p in found["results"] if p.get("abstract") or p.get("tldr")]
    if len(papers) < 5 and query != question:
        more = await aggregator.search(question, source=source, limit=30, filters=filters)
        papers = dedupe(papers + [p for p in more["results"] if p.get("abstract")])
    ranked = rank_papers(question, papers)[:max(limit, 3)]
    for p in ranked:
        p["key_sentence"] = key_sentence(question, p.get("abstract") or p.get("tldr") or "")

    answer, answer_kind, ai_error = "", "none", None
    if ranked and ai_on:
        progress("Writing an answer from the abstracts", 0.6)
        context = "\n\n".join(_excerpt(p, i + 1) for i, p in enumerate(ranked))
        prompt = (f"Question: {question}\n\nPaper excerpts:\n{context}\n\n"
                  "Write a concise answer (120 to 220 words) in plain language. Cite papers inline as [1], [2]. "
                  "Point out where findings agree or disagree, and note important limits of the evidence.")
        try:
            answer = (await chat(GROUNDING, prompt, max_tokens=700)).strip()
            answer_kind = "ai"
        except AIError as e:
            ai_error = str(e)
    if not answer and ranked:
        lines, seen = [], set()
        for i, p in enumerate(ranked[:6]):
            ks = p.get("key_sentence")
            if ks and ks not in seen:
                seen.add(ks)
                lines.append(f"{ks} [{i + 1}]")
        answer = " ".join(lines)
        answer_kind = "extractive"
    progress("Done", 1.0)
    return {"question": question, "query": query, "answer": answer, "answer_kind": answer_kind,
            "papers": ranked, "used": found["used"], "errors": found["errors"], "ai_error": ai_error}


async def summarize(paper: dict, use_ai: bool = True) -> dict:
    if use_ai and is_enabled() and (paper.get("abstract") or paper.get("oa_url")):
        text, kind = await get_text(paper)
        if text:
            out = await chat(GROUNDING, (
                f"Paper: {paper.get('title')}\nText ({kind}):\n{text[:12000]}\n\n"
                "Summarize in 3 short bullet points: aim, method, main finding. Plain language, max 70 words total."),
                max_tokens=300)
            return {"summary": out.strip(), "kind": "ai", "based_on": kind}
    if paper.get("tldr"):
        return {"summary": paper["tldr"], "kind": "source", "based_on": "abstract"}
    sents = split_sentences(paper.get("abstract") or "")
    if sents:
        pick = [sents[0]] + ([sents[-1]] if len(sents) > 1 else [])
        return {"summary": " ".join(pick), "kind": "extractive", "based_on": "abstract"}
    return {"summary": "", "kind": "none", "based_on": None}


PRESET_COLUMNS = [
    {"name": "Aim", "instruction": "The main research question or objective."},
    {"name": "Study type", "instruction": "Experimental, numerical, field study, review, survey, case study, etc."},
    {"name": "Method", "instruction": "Key methods, models, tests or analysis used."},
    {"name": "Sample / data", "instruction": "Sample size, specimens, dataset or participants."},
    {"name": "Location", "instruction": "Country or region where the study was done, if stated."},
    {"name": "Key findings", "instruction": "The main results, with numbers where given."},
    {"name": "Limitations", "instruction": "Limitations stated by the authors."},
    {"name": "Future work", "instruction": "Future research the authors suggest."},
]


async def extract_one(paper: dict, columns: list[dict]) -> dict:
    text, kind = await get_text(paper)
    if not text:
        return {"paper_id": paper["id"], "based_on": None, "values": {},
                "error": "No abstract or open access text available"}
    spec = "\n".join(f"- {c['name']}: {c.get('instruction') or c['name']}" for c in columns)
    prompt = (
        f"Paper: {paper.get('title')} ({paper.get('year') or 'n.d.'})\nText ({kind}):\n{text}\n\n"
        f"Extract these fields:\n{spec}\n\n"
        'Reply with JSON only, shaped as {"<field name>": {"value": "<short answer>", "quote": "<exact supporting '
        'quote from the text, max 25 words>"}}. Use "Not reported" when the text does not say.')
    raw = await chat(GROUNDING, prompt, max_tokens=1400, json_mode=True)
    data = parse_json(raw)
    values = {}
    for c in columns:
        v = data.get(c["name"]) if isinstance(data, dict) else None
        if isinstance(v, dict):
            values[c["name"]] = {"value": str(v.get("value", "")).strip(), "quote": str(v.get("quote", "")).strip()}
        elif v is not None:
            values[c["name"]] = {"value": str(v).strip(), "quote": ""}
        else:
            values[c["name"]] = {"value": "Not reported", "quote": ""}
    return {"paper_id": paper["id"], "based_on": kind, "values": values, "error": None}


async def extract(papers: list[dict], columns: list[dict],
                  progress: Callable[[str, float], None] | None = None) -> list[dict]:
    progress = progress or (lambda m, f: None)
    if not is_enabled():
        raise AIError("Table extraction needs an AI provider. Pick one in Settings, AI. "
                      "Ollama is free and runs on your computer.")
    rows = []
    for i, p in enumerate(papers):
        progress(f"Reading paper {i + 1} of {len(papers)}", i / max(len(papers), 1))
        try:
            rows.append(await extract_one(p, columns))
        except AIError as e:
            rows.append({"paper_id": p["id"], "based_on": None, "values": {}, "error": str(e)})
    progress("Done", 1.0)
    return rows


async def suggest(question: str, limit: int = 10) -> dict:
    """Ask the AI for relevant papers, then keep only those that exist in Crossref or OpenAlex."""
    if not is_enabled():
        raise AIError("AI suggestions need an AI provider. Pick one in Settings, AI.")
    raw = await chat(
        "You know the scholarly literature well. Suggest real, published papers only. "
        "If unsure of a detail, leave it empty rather than guessing.",
        f"Topic: {question}\n\nList up to {limit} highly relevant papers. Reply with JSON only: "
        '{"papers": [{"title": "", "first_author": "", "year": 0, "doi": ""}]}',
        max_tokens=1500, json_mode=True)
    data = parse_json(raw)
    items = data.get("papers", []) if isinstance(data, dict) else data
    return await verify_suggestions([i for i in items[:limit] if isinstance(i, dict)])


def _best_title_match(title: str, year, candidates: list[dict]) -> dict | None:
    """The candidate whose title matches best (similarity 0.7 or more), with the year within 1 when known."""
    try:
        want_year = int(str(year)[:4]) if year else None
    except ValueError:
        want_year = None
    best, best_score = None, 0.0
    for c in candidates:
        if want_year and c.get("year") and abs(c["year"] - want_year) > 1:
            continue
        score = title_similarity(title, c.get("title"))
        if score >= 0.7 and score > best_score:
            best, best_score = c, score
    return best


async def verify_suggestions(items: list[dict]) -> dict:
    """Keep only suggested papers that exist in Crossref or OpenAlex. Used for AI and chatbot suggestions."""
    verified, rejected = [], []

    async def check(item: dict):
        title = (item.get("title") or "").strip()
        if not title:
            return
        p = None
        doi = (item.get("doi") or "").strip()
        if doi:
            try:
                p = await aggregator.resolve(doi)
            except Exception:  # noqa: BLE001
                p = None
            if p and len(set(title.lower().split()) & set((p.get("title") or "").lower().split())) < 3:
                p = None  # the DOI points to a different paper
        if not p:
            try:
                p = await S.crossref.verify(title, item.get("first_author") or "", item.get("year") or None)
            except Exception:  # noqa: BLE001
                p = None
        if not p and S.openalex.ready()[0]:
            try:
                p = _best_title_match(title, item.get("year"), await S.openalex.search(title, limit=5))
            except Exception:  # noqa: BLE001
                p = None
        if p:
            p["verified"] = True
            verified.append(p)
        else:
            rejected.append(title)

    await asyncio.gather(*(check(i) for i in items))
    return {"results": verified, "rejected": rejected}


def table_to_csv_rows(columns: list[dict], rows: list[dict], papers: dict[str, dict]) -> list[list[str]]:
    header = ["Title", "Year", "DOI", "Based on"] + [c["name"] for c in columns]
    out = [header]
    for r in rows:
        p = papers.get(r["paper_id"], {})
        out.append([p.get("title", ""), str(p.get("year") or ""), p.get("doi") or "", r.get("based_on") or ""]
                   + [(r.get("values", {}).get(c["name"]) or {}).get("value", "") for c in columns])
    return out


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)
