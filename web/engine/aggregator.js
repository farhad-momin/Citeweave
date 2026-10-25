// One place that talks to all sources: search, look up, references, citations.
// Each operation tries the researcher's preferred sources in order and moves to the next
// when a source is off, missing a key, out of allowance or unreachable.
// Mirrors citeweave/aggregator.py.
import { papers as paperStore } from "./db.js";
import { cleanPaper } from "./library.js";
import { dedupe, mergePapers, parseIdentifier } from "./models.js";
import { SourceError } from "./net.js";
import { settings } from "./settings.js";
import * as S from "./sources/index.js";

const errText = (e) => String(e && e.message ? e.message : e);

export function searchOrder() {
  const order = settings().get("search", "order") || [];
  return [...order.filter((n) => S.SEARCHABLE.includes(n)), ...S.SEARCHABLE.filter((n) => !order.includes(n))];
}

// Returns {results, used, errors}.
export async function search(query, source = "auto", limit = 25, filters = null) {
  filters = filters || {};
  const errors = {};
  let names;
  let mode;
  if (source && source !== "auto") {
    names = [source];
    mode = "single";
  } else {
    names = searchOrder().filter((n) => S.ALL[n].ready()[0]);
    mode = settings().get("search", "mode") || "fallback";
  }

  const run = async (name) => {
    const src = S.ALL[name];
    if (!src) throw new SourceError(`Unknown source: ${name}`);
    const [ok, reason] = src.ready();
    if (!ok) throw new SourceError(reason);
    return src.search(query, limit, filters);
  };

  let results = [];
  const used = [];
  if (mode === "merge") {
    const pick = names.slice(0, 4);
    const outs = await Promise.allSettled(pick.map(run));
    outs.forEach((o, i) => {
      if (o.status === "rejected") errors[pick[i]] = errText(o.reason);
      else { used.push(pick[i]); results.push(...o.value); }
    });
    results = dedupe(results);
  } else {
    for (const n of names) {
      let out;
      try {
        out = await run(n);
      } catch (e) {
        errors[n] = errText(e);
        continue;
      }
      used.push(n);
      results = dedupe(out);
      if (results.length || mode === "single") break;
    }
  }
  if (filters.oa_only) {
    const oa = results.filter((p) => p.oa_url);
    if (oa.length) results = oa;
  }
  return { results: results.slice(0, limit * 2), used, errors };
}

// Look up one paper from a DOI, arXiv id, PMID, PMCID, OpenAlex or Semantic Scholar id, or URL.
export async function resolve(identifier) {
  const parsed = parseIdentifier(identifier);
  if (!parsed) return null;
  return lookup(parsed[0], parsed[1]);
}

// Like the PC app's upsert_paper: new non-empty values win, stored values are kept otherwise
// (an Unpaywall link or summary saved earlier is not wiped by a plainer record).
async function upsertPaper(p) {
  p = cleanPaper(p);
  const old = await paperStore.get(p.id);
  if (!old) return paperStore.put(p);
  const merged = { ...old };
  for (const [k, v] of Object.entries(p)) {
    const empty = v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) ||
      (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
    if (!empty) merged[k] = v;
  }
  return paperStore.put(cleanPaper(merged));
}

const CHAINS = {
  doi: ["openalex", "semanticscholar", "crossref", "europepmc"],
  arxiv: ["semanticscholar", "openalex", "arxiv"],
  pmid: ["openalex", "semanticscholar", "europepmc", "pubmed"],
  pmcid: ["openalex", "semanticscholar", "europepmc"],
  openalex: ["openalex"],
  s2: ["semanticscholar"],
};

export async function lookup(kind, value) {
  const key = `${kind}:${value}`;
  if (kind === "doi") {
    try {
      const stored = await paperStore.get(key);
      if (stored && stored.abstract && (stored.ids || {}).openalex) return stored;
    } catch { /* storage is best effort */ }
  }
  let found = null;
  for (const name of CHAINS[kind] || []) {
    const src = S.ALL[name];
    if (!src.ready()[0]) continue;
    let p;
    try {
      p = await src.paper(kind, value);
    } catch {
      continue;
    }
    if (p) {
      found = found ? mergePapers(found, p) : p;
      // good enough once there is an abstract and an OpenAlex id (needed for maps)
      if (found.abstract && (found.ids || {}).openalex) break;
    }
  }
  if (found) {
    try { await upsertPaper(found); } catch { /* ignore */ }
  }
  return found;
}

// Fill gaps: short summary from Semantic Scholar and an open access link from Unpaywall.
export async function enrich(paper) {
  let p = { ...paper };
  const ids = p.ids || {};
  const tasks = [];
  if (!p.tldr || !p.abstract) {
    if (S.semanticscholar.ready()[0] && (p.doi || ids.arxiv || ids.s2)) {
      const [kind, val] = p.doi ? ["doi", p.doi] : ids.arxiv ? ["arxiv", ids.arxiv] : ["s2", ids.s2];
      tasks.push(S.semanticscholar.paper(kind, val));
    }
  }
  if (!p.oa_url && p.doi && S.unpaywall.ready()[0]) tasks.push(S.unpaywall.oaLink(p.doi));
  const outs = await Promise.allSettled(tasks);
  for (const o of outs) {
    if (o.status !== "fulfilled" || !o.value) continue;
    const out = o.value;
    if ("pdf" in out && "status" in out) {
      p.oa_url = out.pdf || out.page || p.oa_url;
      p.oa_status = out.status;
    } else {
      p = mergePapers(p, out);
    }
  }
  return p;
}

async function papersForDois(dois) {
  if (!dois.length) return [];
  if (S.openalex.ready()[0]) {
    try {
      const out = await S.openalex.batchDois(dois);
      if (out.length) return out;
    } catch { /* next */ }
  }
  if (S.semanticscholar.ready()[0]) {
    try {
      return await S.semanticscholar.batch(dois.map((d) => `DOI:${d}`));
    } catch { /* next */ }
  }
  const out = [];
  for (const d of dois.slice(0, 40)) {
    try {
      const p = await S.crossref.paper("doi", d);
      if (p) out.push(p);
    } catch {
      break;
    }
  }
  return out;
}

const aborted = (e) => e?.name === "AbortError";

export async function references(paper, limit = 200, signal = undefined) {
  const errors = {};
  if (S.openalex.ready()[0]) {
    try {
      const out = await S.openalex.references(paper, limit, signal);
      if (out.length) return { results: out, used: "openalex", errors };
    } catch (e) { if (aborted(e)) throw e; errors.openalex = errText(e); }
  }
  if (S.semanticscholar.ready()[0]) {
    try {
      const out = await S.semanticscholar.references(paper, limit);
      if (out.length) return { results: out, used: "semanticscholar", errors };
    } catch (e) { errors.semanticscholar = errText(e); }
  }
  if (paper.doi) {
    try {
      let dois = [];
      if (S.opencitations.enabled()) dois = await S.opencitations.referenceDois(paper.doi);
      if (!dois.length && S.crossref.enabled()) {
        const full = await S.crossref.paper("doi", paper.doi);
        dois = (full || {}).reference_dois || [];
      }
      const out = await papersForDois(dois.slice(0, limit));
      if (out.length) return { results: out, used: "opencitations", errors };
    } catch (e) { errors.opencitations = errText(e); }
  }
  return { results: [], used: null, errors };
}

export async function citations(paper, limit = 200, signal = undefined) {
  const errors = {};
  if (S.openalex.ready()[0]) {
    try {
      const out = await S.openalex.citations(paper, limit, null, signal);
      if (out.length) return { results: out, used: "openalex", errors };
    } catch (e) { if (aborted(e)) throw e; errors.openalex = errText(e); }
  }
  if (S.semanticscholar.ready()[0]) {
    try {
      const out = await S.semanticscholar.citations(paper, limit);
      if (out.length) return { results: out, used: "semanticscholar", errors };
    } catch (e) { errors.semanticscholar = errText(e); }
  }
  if (paper.doi && S.opencitations.enabled()) {
    try {
      const dois = await S.opencitations.citationDois(paper.doi);
      const out = await papersForDois(dois.slice(0, limit));
      if (out.length) return { results: out, used: "opencitations", errors };
    } catch (e) { errors.opencitations = errText(e); }
  }
  return { results: [], used: null, errors };
}

// Papers similar to a set, from Semantic Scholar's recommender plus OpenAlex related works.
export async function recommend(papers, limit = 30) {
  let results = [];
  const errors = {};
  const have = new Set(papers.map((p) => p.id));
  if (S.semanticscholar.ready()[0]) {
    try {
      results.push(...await S.semanticscholar.recommend(papers, null, limit));
    } catch (e) { errors.semanticscholar = errText(e); }
  }
  if (S.openalex.ready()[0]) {
    for (const p of papers.slice(0, 5)) {
      try {
        results.push(...await S.openalex.related(p, 10));
      } catch (e) {
        errors.openalex = errText(e);
        break;
      }
    }
  }
  results = dedupe(results).filter((r) => !have.has(r.id));
  return { results: results.slice(0, limit), errors };
}
