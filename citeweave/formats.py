"""Citation formats: BibTeX, RIS and CSV export; BibTeX, RIS and DOI list import; APA style text."""
from __future__ import annotations

import csv
import io
import re
import unicodedata

from .models import DOI_RE, make_paper, normalize_doi


def _ascii(s: str) -> str:
    return unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()


def _split_name(name: str) -> tuple[str, str]:
    name = (name or "").strip()
    if "," in name:
        last, first = [x.strip() for x in name.split(",", 1)]
        return first, last
    parts = name.split()
    if len(parts) == 1:
        return "", parts[0]
    return " ".join(parts[:-1]), parts[-1]


def bibtex_key(p: dict, used: set[str]) -> str:
    first = (p.get("authors") or [{"name": "anon"}])[0]["name"]
    last = re.sub(r"[^A-Za-z]", "", _ascii(_split_name(first)[1])) or "anon"
    word = next((w for w in re.findall(r"[A-Za-z]{4,}", _ascii(p.get("title") or "")) if w.lower() not in
                 {"with", "from", "that", "this", "using", "their", "into", "study"}), "paper")
    base = f"{last.lower()}{p.get('year') or ''}{word.lower()}"
    key, i = base, 1
    while key in used:
        i += 1
        key = f"{base}{chr(96 + i)}" if i < 27 else f"{base}{i}"
    used.add(key)
    return key


def _bib_escape(s: str) -> str:
    return (s or "").replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}").replace("&", "\\&").replace("%", "\\%")


def to_bibtex(papers: list[dict]) -> str:
    used: set[str] = set()
    out = []
    for p in papers:
        kind = {"preprint": "misc", "book-chapter": "incollection", "book": "book",
                "proceedings-article": "inproceedings"}.get(p.get("type") or "", "article")
        fields = {
            "title": "{" + _bib_escape(p.get("title")) + "}",
            "author": " and ".join(_bib_escape(a["name"]) for a in p.get("authors") or []),
            "year": str(p.get("year") or ""),
            "journal" if kind == "article" else "booktitle" if kind in ("inproceedings", "incollection") else "howpublished":
                _bib_escape(p.get("venue") or ""),
            "doi": p.get("doi") or "",
            "url": p.get("url") or "",
            "abstract": _bib_escape(p.get("abstract") or ""),
        }
        if p.get("ids", {}).get("arxiv"):
            fields["eprint"] = p["ids"]["arxiv"]
            fields["archiveprefix"] = "arXiv"
        body = ",\n".join(f"  {k} = {{{v}}}" if not v.startswith("{") else f"  {k} = {v}"
                          for k, v in fields.items() if v and v != "{}")
        out.append(f"@{kind}{{{bibtex_key(p, used)},\n{body}\n}}")
    return "\n\n".join(out) + "\n"


def to_ris(papers: list[dict]) -> str:
    out = []
    for p in papers:
        ty = {"preprint": "UNPB", "book": "BOOK", "book-chapter": "CHAP", "proceedings-article": "CPAPER"}.get(
            p.get("type") or "", "JOUR")
        lines = [f"TY  - {ty}", f"TI  - {p.get('title') or ''}"]
        for a in p.get("authors") or []:
            first, last = _split_name(a["name"])
            lines.append(f"AU  - {last}, {first}".rstrip(", "))
        if p.get("year"):
            lines.append(f"PY  - {p['year']}")
        if p.get("venue"):
            lines.append(f"T2  - {p['venue']}")
        if p.get("doi"):
            lines.append(f"DO  - {p['doi']}")
        if p.get("url"):
            lines.append(f"UR  - {p['url']}")
        if p.get("abstract"):
            lines.append(f"AB  - {p['abstract']}")
        if p.get("note"):
            lines.append(f"N1  - {p['note']}")
        for t in p.get("tags") or []:
            lines.append(f"KW  - {t}")
        lines.append("ER  - ")
        out.append("\n".join(lines))
    return "\n\n".join(out) + "\n"


def to_csv(papers: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Title", "Authors", "Year", "Venue", "DOI", "Cited by", "Open access link", "Status", "Tags", "Notes",
                "Abstract"])
    for p in papers:
        w.writerow([p.get("title"), "; ".join(a["name"] for a in p.get("authors") or []), p.get("year") or "",
                    p.get("venue") or "", p.get("doi") or "", p.get("cited_by_count") or "", p.get("oa_url") or "",
                    p.get("status") or "", "; ".join(p.get("tags") or []), p.get("note") or "", p.get("abstract") or ""])
    return buf.getvalue()


def rows_to_csv(rows: list[list[str]]) -> str:
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    return buf.getvalue()


def apa(p: dict) -> str:
    names = []
    for a in (p.get("authors") or [])[:20]:
        first, last = _split_name(a["name"])
        initials = " ".join(f"{x[0]}." for x in re.split(r"[\s\-]+", first) if x)
        names.append(f"{last}, {initials}".strip(", "))
    if len(names) > 1:
        authors = ", ".join(names[:-1]) + ", & " + names[-1]
    else:
        authors = names[0] if names else ""
    year = p.get("year") or "n.d."
    s = f"{authors} ({year}). {p.get('title') or ''}."
    if p.get("venue"):
        s += f" {p['venue']}."
    if p.get("doi"):
        s += f" https://doi.org/{p['doi']}"
    return s.strip()


# import -----------------------------------------------------------------------
def _bib_entries(text: str):
    """Yield (type, body) for each @type{...} entry, matching braces properly."""
    i, n = 0, len(text)
    while True:
        m = re.compile(r"@(\w+)\s*([{(])").search(text, i)
        if not m:
            return
        kind, open_ch = m.group(1).lower(), m.group(2)
        close_ch = "}" if open_ch == "{" else ")"
        depth, j = 1, m.end()
        while j < n and depth:
            c = text[j]
            if c == "{" or (c == open_ch and open_ch == "("):
                depth += 1
            elif c == "}" or (c == close_ch and close_ch == ")"):
                depth -= 1
            j += 1
        if kind not in ("comment", "preamble", "string"):
            yield kind, text[m.end():j - 1]
        i = j


def _bib_fields(body: str) -> dict[str, str]:
    """Parse 'key, field = {value}, field = "value", field = 2020' into a dict."""
    fields: dict[str, str] = {}
    comma = body.find(",")
    if comma < 0:
        return fields
    s, i, n = body, comma + 1, len(body)
    while i < n:
        m = re.compile(r"\s*([\w\-:.]+)\s*=\s*").match(s, i)
        if not m:
            nxt = s.find(",", i)
            if nxt < 0:
                break
            i = nxt + 1
            continue
        name, i = m.group(1).lower(), m.end()
        parts: list[str] = []
        while i < n:
            c = s[i]
            if c == "{":
                depth, j = 1, i + 1
                while j < n and depth:
                    depth += {"{": 1, "}": -1}.get(s[j], 0)
                    j += 1
                parts.append(s[i + 1:j - 1])
                i = j
            elif c == '"':
                j = i + 1
                depth = 0
                while j < n and not (s[j] == '"' and depth == 0):
                    depth += {"{": 1, "}": -1}.get(s[j], 0)
                    j += 1
                parts.append(s[i + 1:j])
                i = j + 1
            else:
                m2 = re.compile(r"[^,#\s}]+").match(s, i)
                if m2:
                    parts.append(m2.group(0))
                    i = m2.end()
            m3 = re.compile(r"\s*#\s*").match(s, i)  # string concatenation
            if m3:
                i = m3.end()
                continue
            break
        val = "".join(parts)
        fields[name] = " ".join(val.replace("{", "").replace("}", "").split())
        nxt = re.compile(r"\s*,").match(s, i)
        i = nxt.end() if nxt else i + 1
    return fields


def parse_bibtex(text: str) -> list[dict]:
    out = []
    for _kind, body in _bib_entries(text):
        fields = _bib_fields(body)
        if not fields.get("title"):
            continue
        authors = [{"name": a.strip()} for a in re.split(r"\s+and\s+", fields.get("author", "")) if a.strip()]
        out.append(make_paper(
            source="import", title=fields.get("title"), doi=fields.get("doi"), abstract=fields.get("abstract"),
            year=fields.get("year"), venue=fields.get("journal") or fields.get("booktitle"), authors=authors,
            url=fields.get("url"), ids={"arxiv": fields.get("eprint")} if fields.get("archiveprefix", "").lower() == "arxiv" else {},
        ))
    return out


def parse_ris(text: str) -> list[dict]:
    out, cur = [], {}
    for line in text.splitlines():
        m = re.match(r"^([A-Z][A-Z0-9])\s{2}-\s?(.*)$", line)
        if not m:
            continue
        tag, val = m.group(1), m.group(2).strip()
        if tag == "TY":
            cur = {"AU": []}
        elif tag == "ER":
            if cur.get("TI") or cur.get("T1"):
                out.append(make_paper(
                    source="import", title=cur.get("TI") or cur.get("T1"), doi=cur.get("DO"), abstract=cur.get("AB"),
                    year=(cur.get("PY") or cur.get("Y1") or cur.get("DA") or "")[:4],
                    venue=cur.get("T2") or cur.get("JO") or cur.get("JF"),
                    authors=[{"name": a} for a in cur.get("AU", [])], url=cur.get("UR")))
            cur = {}
        elif tag in ("AU", "A1"):
            cur.setdefault("AU", []).append(val)
        else:
            cur.setdefault(tag, val)
    return out


def find_dois(text: str) -> list[str]:
    return list(dict.fromkeys(d for d in (normalize_doi(m.group(0)) for m in DOI_RE.finditer(text or "")) if d))


def detect_and_parse(text: str) -> tuple[str, list[dict]]:
    t = text.lstrip()
    if t.startswith("@") or re.search(r"@\w+\s*\{", t[:2000]):
        return "bibtex", parse_bibtex(text)
    if re.search(r"^TY\s{2}-", t, flags=re.M):
        return "ris", parse_ris(text)
    return "dois", []
