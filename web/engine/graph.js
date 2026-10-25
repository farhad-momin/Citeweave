// Citation maps. Mirrors citeweave/graph.py.
//
// From one or more seed papers, gather their references and the papers that cite them,
// then rank every candidate by how strongly it is tied to the seeds:
//   direct links            the candidate cites a seed or is cited by a seed
//   bibliographic coupling  the candidate and the seeds cite the same works
//   co-citation             later papers cite the candidate together with the seeds
// Coupling and co-citation use cosine (Salton) normalization, the three signals are scaled
// to 0..1 and combined.
import * as aggregator from "./aggregator.js";
import * as S from "./sources/index.js";

export const WEIGHTS = { direct: 0.4, coupling: 0.3, cocitation: 0.3 };

export const nodeKey = (p) => (p.ids || {}).openalex || p.id;

// accept a Map or a plain object keyed by node key
const asMap = (x) => (x instanceof Map ? x : new Map(Object.entries(x || {})));

const round4 = (x) => Math.round(x * 10000) / 10000;

export function trim(p) {
  const keep = ["id", "doi", "title", "year", "venue", "authors", "cited_by_count", "reference_count",
    "oa_url", "url", "ids", "abstract", "tldr", "topics", "type"];
  const out = {};
  for (const k of keep) out[k] = p[k] === undefined ? null : p[k];
  out.authors = (p.authors || []).slice(0, 6);
  return out;
}

// seedData: [{seed, refs: [paper], cites: [paper]}]. Pure function. Returns a Map key -> candidate.
export function scoreCandidates(seedData) {
  const seedKeys = new Set(seedData.map((s) => nodeKey(s.seed)));
  const seedRefKeys = new Set();
  const citerRefs = [];
  for (const s of seedData) {
    for (const r of s.refs) seedRefKeys.add(nodeKey(r));
    for (const r of s.seed.references || []) seedRefKeys.add(r);
    for (const c of s.cites) citerRefs.push(new Set(c.references || []));
  }
  const nCiters = Math.max(citerRefs.length, 1);

  const cand = new Map();
  for (const s of seedData) {
    const sk = nodeKey(s.seed);
    for (const [rel, items] of [["ref", s.refs], ["cite", s.cites]]) {
      for (const p of items) {
        const k = nodeKey(p);
        if (seedKeys.has(k)) continue;
        if (!cand.has(k)) cand.set(k, { paper: p, direct: new Set(), links: new Set() });
        const c = cand.get(k);
        c.direct.add(sk);
        c.links.add(`${rel}\u0000${sk}`);
        if ((p.abstract || "").length > (c.paper.abstract || "").length) c.paper = p;
      }
    }
  }

  for (const [k, c] of cand) {
    const refsC = new Set(c.paper.references || []);
    let shared = 0;
    for (const r of refsC) if (seedRefKeys.has(r)) shared++;
    c.coupling_raw = shared;
    c.coupling = shared ? shared / Math.sqrt(Math.max(refsC.size, 1) * Math.max(seedRefKeys.size, 1)) : 0;
    let co = 0;
    for (const refs of citerRefs) if (refs.has(k)) co++;
    c.cocitation_raw = co;
    const cited = Math.max(c.paper.cited_by_count || 0, co, 1);
    c.cocitation = co ? co / Math.sqrt(cited * nCiters) : 0;
    c.direct_n = c.direct.size / Math.max(seedKeys.size, 1);
  }

  const scale = (field) => {
    let top = 0;
    for (const c of cand.values()) top = Math.max(top, c[field]);
    top = top || 1;
    for (const c of cand.values()) c[field + "_s"] = c[field] / top;
  };
  scale("coupling");
  scale("cocitation");
  for (const c of cand.values()) {
    c.score = round4(WEIGHTS.direct * c.direct_n + WEIGHTS.coupling * c.coupling_s + WEIGHTS.cocitation * c.cocitation_s);
  }
  return cand;
}

export function buildEdges(nodes, cand) {
  nodes = asMap(nodes);
  cand = asMap(cand);
  const edges = new Set();
  const keys = new Set(nodes.keys());
  for (const [k, n] of nodes) {
    for (const r of n.paper.references || []) if (keys.has(r) && r !== k) edges.add(`${k}\u0000${r}`);
  }
  for (const [k, c] of cand) {
    if (!keys.has(k)) continue;
    for (const link of c.links) {
      const [rel, seed] = link.split("\u0000");
      if (keys.has(seed)) edges.add(rel === "ref" ? `${seed}\u0000${k}` : `${k}\u0000${seed}`);
    }
  }
  return [...edges]
    .map((e) => e.split("\u0000"))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([source, target]) => ({ source, target }));
}

// Importance inside the map: a paper cited by important papers is important.
export function pagerank(keys, edges, damping = 0.85, iters = 40) {
  const n = keys.length;
  if (!n) return {};
  const out = new Map(keys.map((k) => [k, []]));
  for (const e of edges) if (out.has(e.source) && out.has(e.target)) out.get(e.source).push(e.target);
  let rank = new Map(keys.map((k) => [k, 1 / n]));
  for (let it = 0; it < iters; it++) {
    const next = new Map(keys.map((k) => [k, (1 - damping) / n]));
    let sink = 0;
    for (const k of keys) if (!out.get(k).length) sink += rank.get(k);
    for (const k of keys) {
      next.set(k, next.get(k) + damping * sink / n);
      const links = out.get(k);
      if (links.length) {
        const share = damping * rank.get(k) / links.length;
        for (const t of links) next.set(t, next.get(t) + share);
      }
    }
    rank = next;
  }
  const top = Math.max(...rank.values()) || 1;
  return Object.fromEntries([...rank].map(([k, v]) => [k, round4(v / top)]));
}

// Older papers that many papers in the map cite: the shared foundations of the topic.
export async function priorWorks(nodes, limit = 15, signal) {
  nodes = asMap(nodes);
  const counts = new Map();
  for (const n of nodes.values()) {
    for (const r of new Set(n.paper.references || [])) {
      if (!nodes.has(r)) counts.set(r, (counts.get(r) || 0) + 1);
    }
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit).filter(([, c]) => c >= 2);
  if (!top.length || !S.openalex.ready()[0]) return [];
  const papers = new Map((await S.openalex.batch(top.map(([k]) => k), signal)).map((p) => [nodeKey(p), p]));
  return top.filter(([k]) => papers.has(k)).map(([k, c]) => ({ key: k, count: c, paper: trim(papers.get(k)) }));
}

// Papers that cite many papers in the map: likely reviews or follow-up work.
export function derivativeWorks(nodes, seedData, _cand, limit = 15) {
  nodes = asMap(nodes);
  const pool = new Map();
  for (const s of seedData) for (const p of s.cites) pool.set(nodeKey(p), p);
  const rows = [];
  for (const [k, p] of pool) {
    if (nodes.has(k)) continue;
    let c = 0;
    for (const r of new Set(p.references || [])) if (nodes.has(r)) c++;
    if (c >= 2) rows.push({ key: k, count: c, paper: trim(p) });
  }
  rows.sort((a, b) => (b.count - a.count) || ((b.paper.year || 0) - (a.paper.year || 0)));
  return rows.slice(0, limit);
}

const throwIfAborted = (signal) => {
  if (signal?.aborted) {
    const e = new Error("Stopped");
    e.name = "AbortError";
    throw e;
  }
};

export async function buildMap(seeds, { maxNodes = 40, perSeed = 150, progress = () => {}, signal } = {}) {
  const seedData = [];
  const errors = {};
  for (let i = 0; i < seeds.length; i++) {
    throwIfAborted(signal);
    const seed = seeds[i];
    progress(`Collecting links for seed ${i + 1} of ${seeds.length}`, 0.1 + 0.7 * i / Math.max(seeds.length, 1));
    const [refs, cites] = await Promise.all([aggregator.references(seed, perSeed, signal), aggregator.citations(seed, perSeed, signal)]);
    for (const [k, v] of Object.entries(refs.errors)) errors[`${k} (references)`] = v;
    for (const [k, v] of Object.entries(cites.errors)) errors[`${k} (citations)`] = v;
    seedData.push({ seed, refs: refs.results, cites: cites.results });
  }
  throwIfAborted(signal);

  progress("Ranking related papers", 0.85);
  const cand = scoreCandidates(seedData);
  const ranked = [...cand].sort((a, b) => b[1].score - a[1].score);

  const nodes = new Map();
  for (const s of seedData) nodes.set(nodeKey(s.seed), { paper: s.seed, seed: true, score: 1.0 });
  for (const [k, c] of ranked.slice(0, maxNodes)) {
    nodes.set(k, {
      paper: c.paper, seed: false, score: c.score,
      direct: c.direct.size, coupling: c.coupling_raw, cocitation: c.cocitation_raw,
    });
  }
  const edges = buildEdges(nodes, cand);
  const pr = pagerank([...nodes.keys()], edges);
  const outNodes = [...nodes].map(([k, n]) => ({
    key: k, seed: n.seed, score: n.score, direct: n.direct || 0,
    coupling: n.coupling || 0, cocitation: n.cocitation || 0,
    importance: pr[k] || 0, paper: trim(n.paper),
  }));
  const more = ranked.slice(maxNodes, maxNodes + 60).map(([k, c]) => ({ key: k, score: c.score, paper: trim(c.paper) }));

  progress("Finding foundational and newer work", 0.92);
  let foundational = [];
  try {
    foundational = await priorWorks(nodes, 15, signal);
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    errors.foundational = String(e?.message || e);
  }
  const newer = derivativeWorks(nodes, seedData, cand);
  progress("Done", 1.0);
  return {
    nodes: outNodes,
    edges,
    more,
    foundational,
    newer,
    stats: { candidates: cand.size, seeds: seeds.length },
    errors,
  };
}
