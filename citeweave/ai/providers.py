"""Language model providers. All optional; the app works fully without any of them.

Most providers speak the same chat completions format, so one class covers them.
Anthropic has its own format and gets its own class.
Keys never leave this computer except in requests to the provider you pick.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

import httpx

from ..config import settings


class AIError(Exception):
    pass


@dataclass
class Preset:
    name: str
    label: str
    base_url: str
    default_model: str
    kind: str = "openai"       # openai | anthropic
    needs_key: bool = True
    key_help: str = ""
    local: bool = False


PRESETS: dict[str, Preset] = {p.name: p for p in [
    Preset("ollama", "Ollama (local, free)", "http://127.0.0.1:11434/v1", "llama3.2", needs_key=False,
           key_help="Install Ollama from ollama.com, then run: ollama pull llama3.2", local=True),
    Preset("openai", "OpenAI (ChatGPT)", "https://api.openai.com/v1", "gpt-4o-mini",
           key_help="Create a key at platform.openai.com/api-keys"),
    Preset("anthropic", "Anthropic (Claude)", "https://api.anthropic.com/v1", "claude-haiku-5-5", kind="anthropic",
           key_help="Create a key at console.anthropic.com"),
    Preset("gemini", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash",
           key_help="Create a key at aistudio.google.com/apikey"),
    Preset("deepseek", "DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat",
           key_help="Create a key at platform.deepseek.com"),
    Preset("groq", "Groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile",
           key_help="Create a key at console.groq.com/keys"),
    Preset("openrouter", "OpenRouter (many models)", "https://openrouter.ai/api/v1", "openrouter/auto",
           key_help="Create a key at openrouter.ai/keys"),
    Preset("mistral", "Mistral", "https://api.mistral.ai/v1", "mistral-small-latest",
           key_help="Create a key at console.mistral.ai"),
    Preset("custom", "Custom (any OpenAI compatible server, e.g. LM Studio)", "http://127.0.0.1:1234/v1", "",
           needs_key=False, key_help="Enter the server address and model name.", local=True),
]}


def active_config() -> dict:
    ai = settings().get("ai", default={}) or {}
    provider = ai.get("provider") or "none"
    if provider == "none" or provider not in PRESETS:
        return {"provider": "none"}
    preset = PRESETS[provider]
    base = (ai.get("base_url") or "").strip() if provider in ("ollama", "custom") else ""
    return {
        "provider": provider,
        "kind": preset.kind,
        "base_url": (base or preset.base_url).rstrip("/"),
        "model": (ai.get("model") or "").strip() or preset.default_model,
        "key": ((ai.get("keys") or {}).get(provider) or "").strip(),
        "needs_key": preset.needs_key,
        "temperature": float(0.2 if ai.get("temperature") in (None, "") else ai.get("temperature")),
        "label": preset.label,
    }


def is_enabled() -> bool:
    cfg = active_config()
    if cfg["provider"] == "none":
        return False
    if cfg["needs_key"] and not cfg["key"]:
        return False
    return bool(cfg["model"])


async def chat(system: str, user: str, *, max_tokens: int = 1200, json_mode: bool = False,
               cfg: dict | None = None, timeout: float = 180) -> str:
    cfg = cfg or active_config()
    if cfg.get("provider") == "none":
        raise AIError("No AI provider is selected. Choose one in Settings, AI.")
    if cfg.get("needs_key") and not cfg.get("key"):
        raise AIError(f"{cfg['label']} needs an API key. Add it in Settings, AI.")
    async with httpx.AsyncClient(timeout=timeout) as c:
        try:
            if cfg["kind"] == "anthropic":
                body = {
                    "model": cfg["model"], "max_tokens": max_tokens, "system": system,
                    "temperature": cfg["temperature"],
                    "messages": [{"role": "user", "content": user}],
                }
                r = await c.post(f"{cfg['base_url']}/messages", json=body, headers={
                    "x-api-key": cfg["key"], "anthropic-version": "2023-06-01", "content-type": "application/json"})
                _raise(r, cfg)
                data = r.json()
                return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
            body: dict[str, Any] = {
                "model": cfg["model"], "temperature": cfg["temperature"], "max_tokens": max_tokens,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            }
            if json_mode and cfg["provider"] in ("openai", "deepseek", "groq", "mistral", "ollama", "gemini"):
                body["response_format"] = {"type": "json_object"}
            headers = {"content-type": "application/json"}
            if cfg.get("key"):
                headers["Authorization"] = f"Bearer {cfg['key']}"
            if cfg["provider"] == "openrouter":
                headers["X-Title"] = "Citeweave"
            r = await c.post(f"{cfg['base_url']}/chat/completions", json=body, headers=headers)
            if r.status_code == 400 and "response_format" in body:
                body.pop("response_format")
                r = await c.post(f"{cfg['base_url']}/chat/completions", json=body, headers=headers)
            _raise(r, cfg)
            data = r.json()
            return (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        except httpx.ConnectError as e:
            hint = " Is Ollama running?" if cfg["provider"] == "ollama" else ""
            raise AIError(f"Could not connect to {cfg['base_url']}.{hint}") from e
        except httpx.TimeoutException as e:
            raise AIError(f"{cfg['label']} took too long to answer. Try a smaller or faster model.") from e
        except httpx.HTTPError as e:
            raise AIError(f"{cfg['label']}: the connection failed ({e.__class__.__name__}). Try again.") from e
        except ValueError as e:  # a reply that is not JSON
            raise AIError(f"{cfg['label']} sent a reply that could not be read.") from e


def _raise(r: httpx.Response, cfg: dict) -> None:
    if r.status_code < 400:
        return
    try:
        err = r.json()
        msg = (err.get("error") or {}).get("message") if isinstance(err.get("error"), dict) else err.get("error")
        msg = msg or err.get("message") or r.text[:200]
    except ValueError:
        msg = r.text[:200]
    if r.status_code in (401, 403):
        raise AIError(f"{cfg['label']} rejected the API key ({r.status_code}). Check it in Settings, AI.")
    if r.status_code == 404:
        raise AIError(f"{cfg['label']}: model '{cfg['model']}' was not found. {msg}")
    if r.status_code == 429:
        raise AIError(f"{cfg['label']}: rate limit or quota reached. {msg}")
    raise AIError(f"{cfg['label']} error {r.status_code}: {msg}")


async def list_models(cfg: dict | None = None) -> list[str]:
    cfg = cfg or active_config()
    if cfg.get("provider") == "none":
        return []
    async with httpx.AsyncClient(timeout=20) as c:
        try:
            if cfg["provider"] == "ollama":
                root = re.sub(r"/v1/?$", "", cfg["base_url"])
                r = await c.get(f"{root}/api/tags")
                _raise(r, cfg)
                return sorted(m["name"] for m in r.json().get("models", []))
            if cfg["kind"] == "anthropic":
                r = await c.get(f"{cfg['base_url']}/models", headers={
                    "x-api-key": cfg["key"], "anthropic-version": "2023-06-01"})
                _raise(r, cfg)
                return [m["id"] for m in r.json().get("data", [])]
            headers = {"Authorization": f"Bearer {cfg['key']}"} if cfg.get("key") else {}
            r = await c.get(f"{cfg['base_url']}/models", headers=headers)
            _raise(r, cfg)
            data = r.json()
            rows = data.get("data") if isinstance(data, dict) else data
            return sorted(str(m.get("id", "")).removeprefix("models/") for m in rows or [] if m.get("id"))
        except httpx.ConnectError as e:
            raise AIError(f"Could not connect to {cfg['base_url']}") from e


def parse_json(text: str) -> Any:
    """Read JSON from a model reply, tolerating code fences and extra prose."""
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t, flags=re.S)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    for open_c, close_c in (("{", "}"), ("[", "]")):
        start, end = t.find(open_c), t.rfind(close_c)
        if start != -1 and end > start:
            try:
                return json.loads(t[start:end + 1])
            except json.JSONDecodeError:
                continue
    raise AIError("The model did not return valid JSON. Try again or use a stronger model.")
