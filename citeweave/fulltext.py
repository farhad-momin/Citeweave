"""Read the full text of open access papers for table extraction.

Only legal open access copies (from the sources' own OA links or Unpaywall) are used.
The extracted text is stored locally so each PDF is downloaded once.
"""
from __future__ import annotations

import io
import logging
import time

from . import sources as S
from .config import settings
from .db import db
from .net import get

log = logging.getLogger("citeweave")
MAX_PDF_BYTES = 40 * 1024 * 1024


def _pdf_text(data: bytes, max_chars: int) -> str:
    from pypdf import PdfReader  # imported lazily: only needed for this feature

    reader = PdfReader(io.BytesIO(data))
    parts: list[str] = []
    total = 0
    for page in reader.pages:
        try:
            t = page.extract_text() or ""
        except Exception:  # noqa: BLE001 - damaged pages are skipped
            continue
        parts.append(t)
        total += len(t)
        if total > max_chars * 1.5:
            break
    text = "\n".join(parts)
    # cut the reference list, which wastes model context
    low = text.lower()
    for marker in ("\nreferences\n", "\nbibliography\n", "\nreferences \n"):
        pos = low.rfind(marker)
        if pos > len(text) * 0.5:
            text = text[:pos]
            break
    return " ".join(text.split())


async def get_text(paper: dict) -> tuple[str, str]:
    """Returns (text, kind) where kind is 'full text' or 'abstract'."""
    max_chars = int(settings().get("fulltext", "max_chars", default=24000))
    abstract = paper.get("abstract") or ""
    if not settings().get("fulltext", "allow_pdf_download", default=True):
        return abstract, "abstract"
    row = db().one("SELECT body FROM fulltext WHERE paper_id=?", (paper["id"],))
    if row and row["body"]:
        return row["body"][:max_chars], "full text"
    url = paper.get("oa_url")
    if not url and paper.get("doi") and S.unpaywall.ready()[0]:
        try:
            link = await S.unpaywall.oa_link(paper["doi"])
            url = (link or {}).get("pdf")
        except Exception:  # noqa: BLE001
            url = None
    if not url:
        return abstract, "abstract"
    try:
        data = await get(url, parse="bytes", ttl=0, retries=1, timeout=60)
        if not data or len(data) > MAX_PDF_BYTES or not data[:5].startswith(b"%PDF"):
            return abstract, "abstract"
        text = _pdf_text(data, max_chars)
    except Exception as e:  # noqa: BLE001
        log.info("full text failed for %s: %s", paper["id"], e)
        return abstract, "abstract"
    if len(text) < 1500:
        return abstract, "abstract"
    db().execute("INSERT OR REPLACE INTO fulltext(paper_id, source_url, body, fetched_at) VALUES (?,?,?,?)",
                 (paper["id"], url, text, time.time()))
    return text[:max_chars], "full text"
