"""Shared HTTP layer: one async client, response cache, polite rate limits and retries."""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
from typing import Any
from urllib.parse import urlencode, urlparse

import httpx

from . import __version__
from .config import settings
from .db import db


class SourceError(Exception):
    """A data source failed or is not configured. The message is shown to the user."""


# Minimum seconds between requests per host. Kept conservative so that one user never
# strains the free public services that make this app possible.
HOST_INTERVAL = {
    "api.openalex.org": 0.12,
    "api.semanticscholar.org": 1.05,
    "api.crossref.org": 0.1,
    "opencitations.net": 0.35,
    "api.opencitations.net": 0.35,
    "export.arxiv.org": 3.0,
    "www.ebi.ac.uk": 0.12,
    "eutils.ncbi.nlm.nih.gov": 0.35,
    "api.unpaywall.org": 0.1,
    "pub.orcid.org": 0.1,
    "api.core.ac.uk": 0.5,
    "api.elsevier.com": 0.2,
}

SECRET_PARAMS = {"api_key", "apikey", "key", "insttoken"}


class _HostLimiter:
    def __init__(self):
        self._locks: dict[str, asyncio.Lock] = {}
        self._last: dict[str, float] = {}

    async def wait(self, host: str) -> None:
        interval = HOST_INTERVAL.get(host, 0.05)
        lock = self._locks.setdefault(host, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            delay = self._last.get(host, 0) + interval - now
            if delay > 0:
                await asyncio.sleep(delay)
            self._last[host] = time.monotonic()


_limiter = _HostLimiter()
_client: httpx.AsyncClient | None = None

# Hosts that just refused or failed to connect. Requests to them fail at once for a short
# while, so the app stays quick when offline instead of waiting on every retry.
_DOWN_FOR = 60.0
_down_until: dict[str, float] = {}


def host_down(host: str) -> bool:
    return _down_until.get(host, 0) > time.monotonic()


def reset_down_hosts() -> None:
    _down_until.clear()


def user_agent() -> str:
    email = settings().get("email") or ""
    contact = f"; mailto:{email}" if email else ""
    return f"Citeweave/{__version__} (+https://github.com/; open source research tool{contact})"


def client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
            headers={"User-Agent": user_agent()},
        )
    return _client


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _cache_key(method: str, url: str, params: dict | None, body: Any) -> str:
    safe = {k: v for k, v in (params or {}).items() if k.lower() not in SECRET_PARAMS}
    raw = method + " " + url + "?" + urlencode(sorted(safe.items()), doseq=True) + json.dumps(body, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


async def request(
    method: str,
    url: str,
    *,
    params: dict | None = None,
    headers: dict | None = None,
    json_body: Any = None,
    ttl: float = 86400,
    parse: str = "json",
    retries: int = 2,
    timeout: float | None = None,
) -> Any:
    """Make a request through the cache. parse = 'json' | 'text' | 'bytes'."""
    params = {k: v for k, v in (params or {}).items() if v not in (None, "")}
    key = _cache_key(method, url, params, json_body)
    if ttl > 0 and parse != "bytes":
        cached = db().cache_get(key)
        if cached is not None:
            return cached

    host = urlparse(url).netloc
    if host_down(host):
        raise SourceError(f"Could not reach {host}. Check your internet connection.")
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        await _limiter.wait(host)
        try:
            resp = await client().request(
                method, url, params=params, headers={"User-Agent": user_agent(), **(headers or {})},
                json=json_body, timeout=timeout or httpx.USE_CLIENT_DEFAULT,
            )
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ProxyError) as e:
            # no connection at all: retrying straight away will not help
            _down_until[host] = time.monotonic() + _DOWN_FOR
            raise SourceError(f"Could not reach {host}. Check your internet connection.") from e
        except httpx.HTTPError as e:
            last_error = e
            if attempt < retries:
                await asyncio.sleep(1.5 * (attempt + 1))
            continue
        if resp.status_code in (429, 500, 502, 503, 504) and attempt < retries:
            retry_after = resp.headers.get("retry-after")
            try:
                wait = min(float(retry_after), 20) if retry_after else 2.0 * (attempt + 1)
            except ValueError:
                wait = 2.0 * (attempt + 1)
            await asyncio.sleep(wait)
            continue
        _down_until.pop(host, None)
        if resp.status_code == 404:
            return None
        if resp.status_code >= 400:
            detail = resp.text[:300].replace("\n", " ")
            raise SourceError(f"{host} answered {resp.status_code}: {detail}")
        if parse == "json":
            try:
                data = resp.json()
            except ValueError as e:
                raise SourceError(f"{host} sent a response that is not JSON") from e
        elif parse == "text":
            data = resp.text
        else:
            return resp.content
        if ttl > 0:
            db().cache_set(key, data, ttl)
        return data
    raise SourceError(f"Could not reach {host}: {last_error}")


async def get(url: str, **kw) -> Any:
    return await request("GET", url, **kw)


async def post(url: str, **kw) -> Any:
    return await request("POST", url, **kw)
