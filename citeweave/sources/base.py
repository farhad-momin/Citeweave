"""Base class every data source plugin follows.

To add a new source: subclass Source, set `name`, `label` and `capabilities`,
implement the methods you support, and register it in sources/__init__.py.
"""
from __future__ import annotations

from typing import Any

from ..config import settings


class Source:
    name = "base"
    label = "Base"
    homepage = ""
    key_required = False      # True if the source does not work at all without a key
    key_help = ""             # where to get a key
    capabilities: set[str] = set()  # search, paper, references, citations, recommend, author

    # helpers ---------------------------------------------------------------
    def cfg(self) -> dict:
        return settings().get("sources", self.name, default={}) or {}

    def key(self) -> str:
        return (self.cfg().get("key") or "").strip()

    def email(self) -> str:
        return (settings().get("email") or "").strip()

    def enabled(self) -> bool:
        return bool(self.cfg().get("enabled", True))

    def ready(self) -> tuple[bool, str]:
        if not self.enabled():
            return False, f"{self.label} is turned off in Settings"
        if self.key_required and not self.key():
            return False, f"{self.label} needs an API key. {self.key_help}"
        return True, ""

    def info(self) -> dict:
        ok, reason = self.ready()
        return {
            "name": self.name,
            "label": self.label,
            "homepage": self.homepage,
            "capabilities": sorted(self.capabilities),
            "key_required": self.key_required,
            "key_help": self.key_help,
            "has_key": bool(self.key()),
            "enabled": self.enabled(),
            "ready": ok,
            "reason": reason,
        }

    # interface ---------------------------------------------------------------
    async def search(self, query: str, limit: int = 25, filters: dict | None = None) -> list[dict]:
        raise NotImplementedError

    async def paper(self, kind: str, value: str) -> dict | None:
        raise NotImplementedError

    async def references(self, paper: dict, limit: int = 200) -> list[dict]:
        raise NotImplementedError

    async def citations(self, paper: dict, limit: int = 200) -> list[dict]:
        raise NotImplementedError


def year_filter(filters: dict | None) -> tuple[Any, Any]:
    f = filters or {}
    return f.get("year_from") or None, f.get("year_to") or None
