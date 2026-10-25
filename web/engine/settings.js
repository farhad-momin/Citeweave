// Settings for the web version. Same shape as the PC app's settings.json, plus web-only
// parts (relay, sync). Secrets are masked before the interface sees them.
import { kv } from "./db.js";

export const DEFAULTS = {
  email: "",
  theme: "system",
  search: {
    mode: "fallback",
    order: ["openalex", "semanticscholar", "crossref", "europepmc", "arxiv", "pubmed", "core", "scopus"],
    per_page: 25,
  },
  sources: {
    openalex: { enabled: true, key: "" },
    semanticscholar: { enabled: true, key: "" },
    crossref: { enabled: true },
    opencitations: { enabled: true, key: "" },
    europepmc: { enabled: true },
    arxiv: { enabled: true },
    pubmed: { enabled: true, key: "" },
    unpaywall: { enabled: true },
    core: { enabled: false, key: "" },
    scopus: { enabled: false, key: "", insttoken: "" },
  },
  ai: {
    provider: "none",
    model: "",
    base_url: "",
    temperature: 0.2,
    keys: { openai: "", anthropic: "", gemini: "", deepseek: "", groq: "", openrouter: "", mistral: "", custom: "" },
  },
  fulltext: { allow_pdf_download: true, max_chars: 24000 },
  profile: { orcid: "", openalex_author: "", s2_author: "", scopus_author: "" },
  smart: { enabled: false },
  // Optional relay for services that refuse direct browser requests (see web/relay/worker.js).
  relay: { url: "" },
  sync: {
    provider: "none", // none | github | folder | gdrive | onedrive
    encrypt: false,
    github: { token: "", repo: "", branch: "main", path: "citeweave-sync.json" },
    auto: true,
  },
};

export const SECRET_PATHS = [
  ["sources", "openalex", "key"],
  ["sources", "semanticscholar", "key"],
  ["sources", "opencitations", "key"],
  ["sources", "pubmed", "key"],
  ["sources", "core", "key"],
  ["sources", "scopus", "key"],
  ["sources", "scopus", "insttoken"],
  ["sync", "github", "token"],
  ...Object.keys(DEFAULTS.ai.keys).map((k) => ["ai", "keys", k]),
];

export const MASK_PREFIX = "••••";

const clone = (o) => JSON.parse(JSON.stringify(o));

export function deepMerge(base, over) {
  const out = clone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = clone(v);
    }
  }
  return out;
}

function getPath(d, path) {
  for (const p of path) {
    if (!d || typeof d !== "object") return undefined;
    d = d[p];
  }
  return d;
}

function setPath(d, path, value) {
  for (const p of path.slice(0, -1)) d = d[p] ??= {};
  d[path[path.length - 1]] = value;
}

export function mask(v) {
  if (!v) return "";
  return v.length > 4 ? MASK_PREFIX + v.slice(-4) : MASK_PREFIX;
}

let _data = clone(DEFAULTS);
let _loaded = false;

export async function loadSettings() {
  try {
    const saved = await kv.get("settings");
    _data = deepMerge(DEFAULTS, saved || {});
  } catch {
    _data = clone(DEFAULTS);
  }
  _loaded = true;
  return _data;
}

export function isLoaded() { return _loaded; }

// settings().get("search", "mode") mirrors the PC app's settings().get(...)
export function settings() {
  return {
    data: _data,
    get(...path) {
      const v = getPath(_data, path);
      return v === undefined || v === null ? undefined : v;
    },
    public() {
      const out = clone(_data);
      for (const p of SECRET_PATHS) {
        const v = getPath(out, p);
        if (v) setPath(out, p, mask(v));
      }
      return out;
    },
  };
}

// Merge a patch from the interface. Masked secrets mean "unchanged".
export async function updateSettings(patch) {
  const p = clone(patch || {});
  for (const path of SECRET_PATHS) {
    const v = getPath(p, path);
    if (typeof v === "string" && v.startsWith(MASK_PREFIX)) setPath(p, path, getPath(_data, path) || "");
  }
  _data = deepMerge(_data, p);
  if (Array.isArray(p?.search?.order)) _data.search.order = p.search.order;
  await kv.set("settings", _data);
  return settings().public();
}

export function resetSettingsForTests(data = {}) {
  _data = deepMerge(DEFAULTS, data);
  _loaded = true;
}
