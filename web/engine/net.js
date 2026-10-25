// Shared HTTP layer for the web version: fetch, response cache, polite spacing per host,
// retries and an offline breaker. Mirrors citeweave/net.py.
import { cache } from "./db.js";
import { settings } from "./settings.js";

export class SourceError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceError";
  }
}

// Minimum seconds between requests per host, kept conservative so one researcher never
// strains the free public services that make this app possible.
export const HOST_INTERVAL = {
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
};

// Services that refuse requests from web pages (checked from a real browser in October 2026:
// Semantic Scholar, arXiv and CORE refused; OpenAlex, Crossref, OpenCitations, Europe PMC,
// PubMed, Unpaywall and ORCID allowed them). Scopus is untested and listed to be safe.
// When a relay is set in Settings, requests to these hosts go through it.
export const RELAY_HOSTS = new Set([
  "api.semanticscholar.org",
  "export.arxiv.org",
  "api.core.ac.uk",
  "api.elsevier.com",
]);

export function relayUrl() {
  return (settings().get("relay", "url") || "").trim().replace(/\/+$/, "");
}

const SECRET_PARAMS = new Set(["api_key", "apikey", "key", "insttoken"]);

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortError()); return; }
  const onAbort = () => { clearTimeout(t); reject(abortError()); };
  // drop the listener when the wait ends, so a long job's signal does not collect one per request
  const t = setTimeout(() => { signal?.removeEventListener?.("abort", onAbort); resolve(); }, ms);
  signal?.addEventListener?.("abort", onAbort, { once: true });
});

function abortError() {
  const e = new Error("Stopped");
  e.name = "AbortError";
  return e;
}

// polite spacing per host: each host keeps a promise chain of reserved slots
const _next = new Map();
async function waitTurn(host, signal) {
  const interval = (HOST_INTERVAL[host] ?? 0.05) * 1000;
  const now = Date.now();
  const slot = Math.max(now, _next.get(host) || 0);
  _next.set(host, slot + interval);
  if (slot > now) await sleep(slot - now, signal);
}

// Hosts that just failed to connect. Requests fail at once for a short while so the app
// stays quick when offline.
const DOWN_FOR = 60_000;
const _downUntil = new Map();

export function hostDown(host) {
  return (_downUntil.get(host) || 0) > Date.now();
}

export function resetDownHosts() {
  _downUntil.clear();
  _next.clear();
}

function unreachable(host) {
  return new SourceError(
    `${host} could not be reached from this page (offline, or the service does not allow web pages). ` +
    "Add a relay in Settings, or use the PC app.");
}

function cleanParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = v;
  }
  return out;
}

function encodeParams(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
    else p.append(k, String(v));
  }
  return p.toString();
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sortedJson(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(sortedJson).join(", ") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ": " + sortedJson(v[k])).join(", ") + "}";
}

export async function cacheKey(method, url, params, body) {
  const safe = {};
  for (const k of Object.keys(params || {}).sort()) if (!SECRET_PARAMS.has(k.toLowerCase())) safe[k] = params[k];
  return sha256(method + " " + url + "?" + encodeParams(safe) + sortedJson(body ?? null));
}

function retryWait(resp, attempt) {
  const ra = resp.headers.get("retry-after");
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n)) return Math.min(n, 20) * 1000;
  }
  return 2000 * (attempt + 1);
}

// Make a request through the cache. parse = "json" | "text" | "bytes" (ArrayBuffer).
export async function request(method, url, {
  params = null, headers = null, json = undefined, ttl = 86400, parse = "json",
  retries = 2, timeout = 30, signal = undefined,
} = {}) {
  params = cleanParams(params);
  const key = await cacheKey(method, url, params, json === undefined ? null : json);
  if (ttl > 0 && parse !== "bytes") {
    try {
      const cached = await cache.get(key);
      if (cached !== undefined && cached !== null) return cached;
    } catch { /* cache is best effort */ }
  }

  const host = new URL(url).host;
  if (hostDown(host)) throw unreachable(host);
  const qs = encodeParams(params);
  const full = qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
  const relay = (settings().get("relay", "url") || "").trim().replace(/\/+$/, "");
  const target = relay && RELAY_HOSTS.has(host) ? `${relay}/?url=${encodeURIComponent(full)}` : full;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await waitTurn(host, signal);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeout * 1000);
    const opts = { method, headers: { ...(headers || {}) }, signal: ctrl.signal };
    if (json !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(json);
    }
    let resp;
    try {
      resp = await fetch(target, opts);
    } catch (e) {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      if (signal?.aborted) throw abortError();
      if (ctrl.signal.aborted) {
        // timed out: retry like the PC app does for read timeouts
        lastError = new Error("timed out");
        if (attempt < retries) await sleep(1500 * (attempt + 1), signal);
        continue;
      }
      // TypeError: no connection, or the service refused a web page (CORS). Retrying will not help.
      _downUntil.set(host, Date.now() + DOWN_FOR);
      throw unreachable(host);
    }
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
    if ([429, 500, 502, 503, 504].includes(resp.status) && attempt < retries) {
      await sleep(retryWait(resp, attempt), signal);
      continue;
    }
    _downUntil.delete(host);
    if (resp.status === 404) return null;
    if (resp.status >= 400) {
      let detail = "";
      try { detail = (await resp.text()).slice(0, 300).replace(/\n/g, " "); } catch { /* ignore */ }
      throw new SourceError(`${host} answered ${resp.status}: ${detail}`);
    }
    let data;
    if (parse === "json") {
      const text = await resp.text();
      try {
        data = JSON.parse(text);
      } catch {
        throw new SourceError(`${host} sent a response that is not JSON`);
      }
    } else if (parse === "text") {
      data = await resp.text();
    } else {
      return await resp.arrayBuffer();
    }
    if (ttl > 0) {
      try { await cache.set(key, data, ttl); } catch { /* ignore */ }
    }
    return data;
  }
  throw new SourceError(`Could not reach ${host}: ${lastError?.message || "no answer"}`);
}

export const get = (url, opts = {}) => request("GET", url, opts);
export const post = (url, opts = {}) => request("POST", url, opts);
