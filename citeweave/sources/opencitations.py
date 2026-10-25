"""OpenCitations Index: open DOI to DOI citation links (CC0). No key needed.

Used as a backup for reference and citation lists. Returns DOIs only;
the app looks up titles through the other sources.
"""
from __future__ import annotations

import re

from ..net import get
from .base import Source

BASE = "https://api.opencitations.net/index/v2"


def _doi_from(ids: str) -> str | None:
    m = re.search(r"doi:(\S+)", ids or "")
    return m.group(1).lower() if m else None


class OpenCitations(Source):
    name = "opencitations"
    label = "OpenCitations"
    homepage = "https://opencitations.net"
    key_help = "Optional. An access token from opencitations.net helps them count usage."
    capabilities = {"reference_dois", "citation_dois"}

    def headers(self) -> dict:
        return {"authorization": self.key()} if self.key() else {}

    async def reference_dois(self, doi: str) -> list[str]:
        data = await get(f"{BASE}/references/doi:{doi}", headers=self.headers(), ttl=86400 * 7)
        return [d for d in (_doi_from(r.get("cited")) for r in data or []) if d]

    async def citation_dois(self, doi: str) -> list[str]:
        data = await get(f"{BASE}/citations/doi:{doi}", headers=self.headers(), ttl=86400)
        return [d for d in (_doi_from(r.get("citing")) for r in data or []) if d]
