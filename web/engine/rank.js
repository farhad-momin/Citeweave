// Lightweight relevance ranking (BM25) that runs instantly on any computer, no AI needed.
// Mirrors citeweave/rank.py.

const STOP = new Set(`a an and are as at be been being but by can could did do does for from had has have how
if in into is it its may might of on or our out should so such than that the their them then there these
they this those to under up via was we were what when where which while who whom why will with within
would you your study studies paper research using use used based effect effects analysis results result
between among also more most other some about over`.split(/\s+/));

export function tokens(text) {
  const words = String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) || [];
  const out = [];
  for (let w of words) {
    if (STOP.has(w) || w.length < 2) continue;
    // tiny stemmer: plural and common suffixes
    for (const suf of ["ies", "es", "s"]) {
      if (w.endsWith(suf) && w.length > suf.length + 3) {
        w = w.slice(0, -suf.length) + (suf === "ies" ? "y" : "");
        break;
      }
    }
    out.push(w);
  }
  return out;
}

const counter = (arr) => {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return m;
};

export function bm25(query, docs, k1 = 1.4, b = 0.75) {
  const q = tokens(query);
  if (!q.length || !docs.length) return docs.map(() => 0);
  const toks = docs.map(tokens);
  const n = docs.length;
  const avgdl = toks.reduce((s, t) => s + t.length, 0) / n || 1;
  const df = new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);
  return toks.map((t) => {
    const tf = counter(t);
    const dl = t.length || 1;
    let s = 0;
    for (const term of q) {
      if (!tf.has(term)) continue;
      const d = df.get(term) || 0;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      const f = tf.get(term);
      s += idf * f * (k1 + 1) / (f + k1 * (1 - b + b * dl / avgdl));
    }
    return s;
  });
}

const round4 = (x) => Math.round(x * 10000) / 10000;

// Blend text relevance with the source's own order and a small citation signal.
export function rankPapers(query, papers) {
  if (!papers.length) return [];
  const docs = papers.map((p) => `${p.title || ""} ${p.title || ""} ${p.abstract || ""}`);
  const rel = bm25(query, docs);
  const top = Math.max(...rel) || 1;
  const out = papers.map((p, i) => {
    const order = 1 - i / Math.max(papers.length, 1);
    const cites = Math.log1p(p.cited_by_count || 0) / 10;
    return { ...p, relevance: round4(0.65 * rel[i] / top + 0.25 * order + 0.10 * Math.min(cites, 1)) };
  });
  out.sort((a, b) => b.relevance - a.relevance);
  return out;
}

export function splitSentences(text) {
  const parts = String(text || "").split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 30);
}

const RESULT_WORDS = /\b(increas|decreas|improv|reduc|higher|lower|significant|found|show|result|conclud|suggest|indicat|outperform|associated|effective)\w*/i;

// The abstract sentence that best answers the query, preferring sentences that report findings.
export function keySentence(query, text) {
  const sents = splitSentences(text);
  if (!sents.length) return "";
  const raw = bm25(query, sents);
  const top = Math.max(...raw) || 1;
  const scores = raw.map((sc, i) => (sc > 0
    ? sc / top + (RESULT_WORDS.test(sents[i]) ? 0.35 : 0) + (/\d/.test(sents[i]) ? 0.15 : 0)
    : 0));
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  return scores[best] > 0 ? sents[best] : sents[0];
}
