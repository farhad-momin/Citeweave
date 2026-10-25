// The common paper record and identifier helpers. Mirrors citeweave/models.py.
//
// Every source converts its own format into the same plain object:
// { id, doi, title, abstract, year, venue, authors: [{name, orcid?}], cited_by_count,
//   reference_count, oa_url, url, type, tldr, topics, ids: {openalex, s2, arxiv, pmid, pmcid},
//   references?: [OpenAlex ids], sources: ["openalex"] }

const DOI_RE = /10\.\d{4,9}\/[^\s"<>]+/i;
const ARXIV_RE = /(?:arxiv[:/ ]|abs\/|pdf\/)?(\d{4}\.\d{4,5})(v\d+)?/i;
const OLD_ARXIV_RE = /(?:arxiv[:/ ]|abs\/|pdf\/)([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i;
const ORCID_RE = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i;
const OPENALEX_RE = /\b(W\d{4,})\b/;
const PMID_RE = /^(?:pmid:)?\s*(\d{5,9})$/i;
const PMCID_RE = /\b(PMC\d{5,9})\b/i;
const S2_RE = /\b([0-9a-f]{40})\b/;

export function normalizeDoi(value) {
  if (!value) return null;
  const m = String(value).match(DOI_RE);
  if (!m) return null;
  let doi = m[0].trim().replace(/[.,;)\]}]+$/, "");
  doi = doi.replace(/(\/abstract|\/full|\/pdf|\/epdf|\.pdf)$/i, "");
  return doi.toLowerCase();
}

// Turn any pasted identifier or URL into [kind, value].
// kinds: doi, arxiv, pmid, pmcid, openalex, s2, orcid
export function parseIdentifier(text) {
  if (!text) return null;
  const t = String(text).trim();
  const doi = normalizeDoi(t);
  if (doi) {
    const m = doi.match(/^10\.48550\/arxiv\.(.+)/);
    if (m) return ["arxiv", m[1]];
    return ["doi", doi];
  }
  if (t.toLowerCase().includes("arxiv") || /^\d{4}\.\d{4,5}(v\d+)?$/.test(t)) {
    const m = t.match(ARXIV_RE) || t.match(OLD_ARXIV_RE);
    if (m) return ["arxiv", m[1]];
  }
  let m = t.match(PMCID_RE);
  if (m) return ["pmcid", m[1].toUpperCase()];
  if (t.toLowerCase().includes("pubmed")) {
    m = t.match(/(\d{5,9})/);
    if (m) return ["pmid", m[1]];
  }
  m = t.match(PMID_RE);
  if (m) return ["pmid", m[1]];
  m = t.match(ORCID_RE);
  if (m && (t.toLowerCase().includes("orcid") || new RegExp(`^${ORCID_RE.source}$`, "i").test(t))) {
    return ["orcid", m[1].toUpperCase()];
  }
  m = t.match(OPENALEX_RE);
  if (m && (t.toLowerCase().includes("openalex") || /^W\d+$/.test(t))) return ["openalex", m[1]];
  m = t.match(S2_RE);
  if (m) return ["s2", m[1]];
  return null;
}

export function titleFingerprint(title) {
  let t = String(title || "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  t = t.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
  return t.split(/\s+/).filter(Boolean).join(" ").slice(0, 160);
}

export function paperKey(doi = null, ids = null, title = null) {
  ids = ids || {};
  if (doi) return `doi:${String(doi).toLowerCase()}`;
  for (const kind of ["arxiv", "pmid", "openalex", "s2", "pmcid", "core", "scopus"]) {
    if (ids[kind]) return `${kind}:${ids[kind]}`;
  }
  return "title:" + titleFingerprint(title || "untitled");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', deg: "°", plusmn: "±", times: "×", micro: "µ" };

export function unescapeHtml(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try { return Number.isFinite(n) ? String.fromCodePoint(n) : all; } catch { return all; }
    }
    const v = ENTITIES[code.toLowerCase()];
    return v === undefined ? all : v;
  });
}

// Strip JATS/HTML tags and collapse whitespace.
export function cleanText(text) {
  if (!text) return "";
  let s = String(text);
  s = s.replace(/<jats:title>[\s\S]*?<\/jats:title>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = unescapeHtml(s);
  s = s.replace(/^\s*(abstract|summary)[:.\s]+/i, "");
  return s.split(/\s+/).filter(Boolean).join(" ");
}

export function abstractFromInvertedIndex(inv) {
  if (!inv) return "";
  const positions = [];
  for (const [word, idxs] of Object.entries(inv)) for (const i of idxs) positions.push([i, word]);
  positions.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return positions.map((p) => p[1]).join(" ");
}

function toInt(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = String(v).trim();
  return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : null;
}

export function makePaper({
  source, title, doi = null, abstract = null, year = null, venue = null, authors = null,
  cited_by_count = null, reference_count = null, oa_url = null, url = null, type = null,
  tldr = null, topics = null, ids = null, references = undefined,
} = {}) {
  doi = normalizeDoi(doi);
  const cleanIds = {};
  for (const [k, v] of Object.entries(ids || {})) if (v) cleanIds[k] = v;
  let y = null;
  if (year) {
    const s = String(year).slice(0, 4);
    y = /^\d{1,4}$/.test(s.trim()) ? parseInt(s, 10) : null;
  }
  const p = {
    id: paperKey(doi, cleanIds, title),
    doi,
    title: cleanText(title) || "Untitled",
    abstract: cleanText(abstract),
    year: y,
    venue: cleanText(venue),
    authors: (authors || []).filter((a) => a && a.name),
    cited_by_count: toInt(cited_by_count),
    reference_count: toInt(reference_count),
    oa_url: oa_url || null,
    url: url || (doi ? `https://doi.org/${doi}` : null),
    type: type || null,
    tldr: cleanText(tldr),
    topics: topics || [],
    ids: cleanIds,
    sources: [source],
  };
  if (references !== undefined && references !== null) p.references = references;
  return p;
}

const isEmpty = (v) => v === null || v === undefined || v === "" || v === "Untitled" ||
  (Array.isArray(v) && v.length === 0) ||
  (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

// Combine two records of the same paper, keeping the richest value of each field.
export function mergePapers(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === "ids") {
      out.ids = { ...(b.ids || {}), ...(a.ids || {}) };
    } else if (k === "sources") {
      out.sources = [...new Set([...(a.sources || []), ...(v || [])])];
    } else if (k === "cited_by_count" || k === "reference_count") {
      const vals = [a[k], v].filter((x) => Number.isInteger(x));
      out[k] = vals.length ? Math.max(...vals) : null;
    } else if (k === "abstract") {
      if ((v || "").length > (a[k] || "").length) out[k] = v;
    } else if (isEmpty(out[k]) && !(v === null || v === undefined || v === "" ||
      (Array.isArray(v) && !v.length) || (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length))) {
      out[k] = v;
    }
  }
  if (out.doi && !String(out.id || "").startsWith("doi:")) out.id = `doi:${out.doi}`;
  return out;
}

// Merge duplicates by DOI, external ids, then normalized title + year.
export function dedupe(papers) {
  const result = [];
  const index = new Map();
  const keysFor = (p) => {
    const ks = [];
    if (p.doi) ks.push("doi:" + p.doi);
    for (const [kind, val] of Object.entries(p.ids || {})) {
      if (val && ["openalex", "s2", "arxiv", "pmid", "pmcid"].includes(kind)) ks.push(`${kind}:${val}`);
    }
    const fp = titleFingerprint(p.title || "");
    if (fp.length > 20) ks.push(`t:${fp}:${p.year || ""}`);
    return ks;
  };
  for (const p of papers) {
    const ks = keysFor(p);
    const hitKey = ks.find((k) => index.has(k));
    let pos;
    if (hitKey === undefined) {
      result.push(p);
      pos = result.length - 1;
    } else {
      pos = index.get(hitKey);
      result[pos] = mergePapers(result[pos], p);
    }
    for (const k of keysFor(result[pos])) index.set(k, pos);
  }
  return result;
}

export function authorNames(p, limit = 3) {
  const names = (p.authors || []).map((a) => a.name);
  if (!names.length) return "";
  if (names.length > limit) return names.slice(0, limit).join(", ") + " et al.";
  return names.join(", ");
}

// Jaccard overlap of the words in two titles, 0..1.
export function titleSimilarity(a, b) {
  const wa = new Set((String(a || "").toLowerCase().match(/[a-z0-9]+/g)) || []);
  const wb = new Set((String(b || "").toLowerCase().match(/[a-z0-9]+/g)) || []);
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}
