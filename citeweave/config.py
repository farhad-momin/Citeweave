"""Settings and data paths.

All user data lives in one folder:
  Windows: %APPDATA%\\Citeweave
  Other:   ~/.citeweave
It can be overridden with the CITEWEAVE_HOME environment variable.
"""
from __future__ import annotations

import copy
import json
import os
import threading
from pathlib import Path
from typing import Any

DEFAULT_PORT = 23120


def data_dir() -> Path:
    env = os.environ.get("CITEWEAVE_HOME")
    if env:
        p = Path(env)
    elif os.name == "nt" and os.environ.get("APPDATA"):
        p = Path(os.environ["APPDATA"]) / "Citeweave"
    else:
        p = Path.home() / ".citeweave"
    p.mkdir(parents=True, exist_ok=True)
    return p


# Every source has: enabled (used by "Auto" search), and an optional key.
DEFAULT_SETTINGS: dict[str, Any] = {
    "email": "",  # used for polite access to Crossref, OpenAlex and Unpaywall. Never required.
    "port": DEFAULT_PORT,
    "theme": "system",
    "search": {
        # "fallback": use the first source that answers; "merge": combine the enabled sources
        "mode": "fallback",
        "order": ["openalex", "semanticscholar", "crossref", "europepmc", "arxiv", "pubmed", "core", "scopus"],
        "per_page": 25,
    },
    "sources": {
        "openalex": {"enabled": True, "key": ""},
        "semanticscholar": {"enabled": True, "key": ""},
        "crossref": {"enabled": True},
        "opencitations": {"enabled": True, "key": ""},
        "europepmc": {"enabled": True},
        "arxiv": {"enabled": True},
        "pubmed": {"enabled": True, "key": ""},
        "unpaywall": {"enabled": True},
        "core": {"enabled": False, "key": ""},
        "scopus": {"enabled": False, "key": "", "insttoken": ""},
    },
    "ai": {
        "provider": "none",  # none | ollama | openai | anthropic | gemini | deepseek | groq | openrouter | mistral | custom
        "model": "",
        "base_url": "",  # only for ollama / custom
        "temperature": 0.2,
        "keys": {
            "openai": "",
            "anthropic": "",
            "gemini": "",
            "deepseek": "",
            "groq": "",
            "openrouter": "",
            "mistral": "",
            "custom": "",
        },
    },
    "fulltext": {
        # When on, open access PDFs may be downloaded to read the full text for table extraction.
        "allow_pdf_download": True,
        "max_chars": 24000,
    },
    "profile": {
        "orcid": "",
        "openalex_author": "",
        "s2_author": "",
        "scopus_author": "",
    },
    # Optional sync of the library, maps, tables and question history (see web/SPEC.md).
    "sync": {
        "provider": "none",  # none | github | folder
        "encrypt": False,
        "folder": "",
        "auto": True,
        "github": {"token": "", "repo": "", "branch": "main", "path": "citeweave-sync.json"},
    },
}

SECRET_PATHS = [
    ("sources", "openalex", "key"),
    ("sources", "semanticscholar", "key"),
    ("sources", "opencitations", "key"),
    ("sources", "pubmed", "key"),
    ("sources", "core", "key"),
    ("sources", "scopus", "key"),
    ("sources", "scopus", "insttoken"),
    ("sync", "github", "token"),
] + [("ai", "keys", k) for k in DEFAULT_SETTINGS["ai"]["keys"]]

MASK_PREFIX = "••••"


def _deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _get(d: dict, path: tuple) -> Any:
    for p in path:
        if not isinstance(d, dict):
            return None
        d = d.get(p)
    return d


def _set(d: dict, path: tuple, value: Any) -> None:
    for p in path[:-1]:
        d = d.setdefault(p, {})
    d[path[-1]] = value


def mask(value: str) -> str:
    if not value:
        return ""
    return MASK_PREFIX + value[-4:] if len(value) > 4 else MASK_PREFIX


class Settings:
    """Thread safe JSON backed settings."""

    def __init__(self, path: Path | None = None):
        self.path = path or (data_dir() / "settings.json")
        self._lock = threading.Lock()
        self._data = self._load()

    def _load(self) -> dict:
        if self.path.exists():
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                return _deep_merge(DEFAULT_SETTINGS, raw)
            except (OSError, json.JSONDecodeError):
                pass
        return copy.deepcopy(DEFAULT_SETTINGS)

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    @property
    def data(self) -> dict:
        return self._data

    def get(self, *path: str, default: Any = None) -> Any:
        v = _get(self._data, path)
        return default if v is None else v

    def public(self) -> dict:
        """Settings safe to send to the UI: secrets are masked."""
        out = copy.deepcopy(self._data)
        for path in SECRET_PATHS:
            v = _get(out, path)
            if v:
                _set(out, path, mask(v))
        return out

    def update(self, patch: dict) -> dict:
        """Merge a patch from the UI. Masked secrets mean 'unchanged'."""
        with self._lock:
            patch = copy.deepcopy(patch or {})
            for path in SECRET_PATHS:
                v = _get(patch, path)
                if isinstance(v, str) and v.startswith(MASK_PREFIX):
                    _set(patch, path, _get(self._data, path) or "")
                elif isinstance(v, str):
                    _set(patch, path, v.strip())
            self._data = _deep_merge(self._data, patch)
            self.save()
        return self.public()


_settings: Settings | None = None


def settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


def reset_settings_for_tests(path: Path) -> Settings:
    global _settings
    _settings = Settings(path)
    return _settings
