// Smart ranking: a small language model (about 25 MB, downloaded once and cached by the browser)
// that ranks papers by meaning instead of shared words. Runs on this computer, no key needed.
// Off by default; turn it on in Settings, Search.
import { api } from "./api.js";
import { toast } from "./ui.js";

const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0";
const MODEL = "Xenova/all-MiniLM-L6-v2";
let extractor = null;   // promise of the model while it loads
let loaded = null;      // the model once it is ready
let enabledCache = { at: 0, value: false };

export async function smartEnabled() {
  if (Date.now() - enabledCache.at < 5000) return enabledCache.value;
  try {
    const s = await api.get("/api/settings");
    enabledCache = { at: Date.now(), value: !!s.smart?.enabled };
  } catch { enabledCache = { at: Date.now(), value: false }; }
  return enabledCache.value;
}
export function forgetSmartSetting() { enabledCache.at = 0; }

async function load() {
  if (!extractor) {
    extractor = (async () => {
      const t = setTimeout(() => toast("Getting the smart ranking model ready in the background (about 25 MB, only the first time). Results are ranked by meaning once it is ready."), 800);
      try {
        const { pipeline, env } = await import(/* webpackIgnore: true */ LIB);
        env.allowLocalModels = false;
        loaded = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
        return loaded;
      } finally { clearTimeout(t); }
    })();
    extractor.catch(() => { extractor = null; });
  }
  return extractor;
}

async function embed(texts, ex) {
  ex ??= await load();
  const out = await ex(texts, { pooling: "mean", normalize: true });
  return out.tolist();
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const textOf = (p) => `${p.title || ""}. ${(p.abstract || p.tldr || "").slice(0, 1200)}`;

const RANK_TIMEOUT = 3000;

// Reorder papers by meaning, blended with their current order so good keyword matches stay near the top.
// Never holds up results: while the model is still downloading it starts the download in the background
// and returns the papers unchanged (the next search uses it), and a slow ranking gives up after 3 seconds.
export async function smartRank(query, papers, { force = false } = {}) {
  if (!papers?.length || !(force || (await smartEnabled()))) return papers;
  if (!loaded) {
    load().catch(() => { /* tried again on the next search */ });
    return papers;
  }
  let timer;
  const vecs = await Promise.race([
    embed([query, ...papers.map(textOf)], loaded).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), RANK_TIMEOUT); }),
  ]).finally(() => clearTimeout(timer));
  if (!vecs) return papers;
  const q = vecs[0];
  const n = papers.length;
  const scored = papers.map((p, i) => {
    const sim = dot(q, vecs[i + 1]);
    return { p, sim, score: 0.7 * sim + 0.3 * (1 - i / n) * Math.max(0.2, sim) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ p, sim }) => ({ ...p, smart_score: Math.round(sim * 1000) / 1000 }));
}

// Quick check used by the Settings page.
export async function testSmart() {
  const [a, b, c] = await embed(["compressive strength of concrete", "strength of cement mixes under load", "bird migration routes"]);
  return dot(a, b) > dot(a, c);
}
