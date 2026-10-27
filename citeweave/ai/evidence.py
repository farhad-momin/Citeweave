"""Conservative, local evidence retrieval and quote checks. No model or network needed."""
from __future__ import annotations

import re
import unicodedata

from ..rank import bm25, tokens

# These English cues find candidate excerpts, not inferred study characteristics.
CUES = {
    "aim": r"\b(aim\w*|objective\w*|purpose|investigat\w*|examin\w*)\b",
    "study type": r"\b(trial|survey|review|meta-analysis|cohort|case.control|experiment\w*|simulation\w*)\b",
    "method": r"\b(method\w*|measur\w*|analys\w*|analyz\w*|regression|random\w*|interview\w*|simulat\w*|tested)\b",
    "sample / data": r"\b(sample\w*|participant\w*|patient\w*|specimen\w*|dataset\w*|respondent\w*|recruit\w*)\b",
    "location": r"\b(conducted in|carried out in|located in|recruited from|study site\w*)\b",
    "key findings": r"\b(found|show\w*|result\w*|increas\w*|decreas\w*|reduc\w*|improv\w*|associat\w*|conclud\w*)\b",
    "limitations": r"\b(limit\w*|caveat\w*|shortcoming\w*)\b",
    "future work": r"\b(future|further research|further studies|remain\w* to be)\b",
}


# Curly quotes and the different dashes are typography only; words, numbers and signs stay exact.
_FOLD = str.maketrans({
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"',
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2212": "-",
})


def normalize_quote(text: str) -> str:
    # Preserve case, punctuation and numbers; only typography/whitespace may differ.
    return " ".join(unicodedata.normalize("NFKC", text).translate(_FOLD).split())


def check_values(values: dict, text: str) -> dict:
    source = normalize_quote(text)
    for cell in values.values():
        quote = normalize_quote(cell.get("quote") or "")
        absent = (cell.get("value") or "").lower() in ("", "not reported", "not found in available text")
        matched = bool(quote and quote in source)
        cell["evidence_status"] = "quote matched" if matched else "not reported" if absent and not quote else "unverified"
        cell["unverified"] = cell["evidence_status"] == "unverified"
    return values


def evidence_row(paper: dict, columns: list[dict], text: str, kind: str | None) -> dict:
    # Keep short sentences too, including "Limitations: Small sample.".
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+|[\r\n]+", text) if s.strip()]
    values = {}
    for col in columns:
        query = f"{col['name']} {col.get('instruction') or ''}"
        cue = CUES.get(col["name"].strip().lower())
        query_words = set(tokens(query))
        candidates = [s for s in sentences if (re.search(cue, s, re.I) if cue else query_words & set(tokens(s)))]
        if candidates:
            scores = bm25(query, candidates)
            excerpt = candidates[max(range(len(candidates)), key=lambda i: scores[i])]
            values[col["name"]] = {"value": excerpt, "quote": excerpt, "evidence_status": "source excerpt",
                                   "unverified": False, "needs_review": True}
        else:
            values[col["name"]] = {"value": "Not found in available text", "quote": "",
                                   "evidence_status": "not found", "unverified": False, "needs_review": True}
    return {"paper_id": paper["id"], "based_on": kind if text else None, "mode": "extractive",
            "values": values, "error": None if text else "No abstract or text available"}
