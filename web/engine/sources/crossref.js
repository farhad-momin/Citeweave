// Crossref: the DOI registration agency's open metadata. No key needed. Adding an email
// in Settings routes requests to Crossref's faster "polite" pool.
import { makePaper, normalizeDoi, titleFingerprint } from "../models.js";
import { get } from "../net.js";
import { Source, yearFilter } from "./base.js";

const BASE = "https://api.crossref.org";

export function toPaper(m) {
  const yearOf = (...keys) => {
    for (const k of keys) {
      const parts = (((m[k] || {})["date-parts"]) || [[null]])[0];
      if (parts && parts[0]) return parts[0];
    }
    return null;
  };
  const authors = (m.author || []).map((a) => {
    const name = [a.given, a.family].filter(Boolean).join(" ") || a.name || "";
    const orcid = String(a.ORCID || "").replace(/\/+$/, "").split("/").pop() || null;
    return { name, orcid };
  });
  const refs = (m.reference || []).filter((r) => r.DOI).map((r) => normalizeDoi(r.DOI));
  const p = makePaper({
    source: "crossref",
    title: (m.title || [""])[0],
    doi: m.DOI,
    abstract: m.abstract,
    year: yearOf("issued", "published", "published-print", "published-online", "created"),
    venue: (m["container-title"] || [""])[0],
    authors,
    cited_by_count: m["is-referenced-by-count"],
    reference_count: m["references-count"],
    url: m.URL,
    type: m.type,
  });
  if (refs.length) p.reference_dois = refs;
  return p;
}

export class Crossref extends Source {
  constructor() {
    super();
    this.name = "crossref";
    this.label = "Crossref";
    this.homepage = "https://www.crossref.org";
    this.capabilities = new Set(["search", "paper", "references", "verify"]);
  }

  params(extra = {}) {
    const p = { ...extra };
    if (this.email()) p.mailto = this.email();
    return p;
  }

  async search(query, limit = 25, filters = null) {
    const filt = [];
    const [y0, y1] = yearFilter(filters);
    if (y0) filt.push(`from-pub-date:${parseInt(y0, 10)}`);
    if (y1) filt.push(`until-pub-date:${parseInt(y1, 10)}`);
    const params = {
      query,
      rows: Math.min(limit, 100),
      select: "DOI,title,author,issued,published-print,published-online,container-title,abstract,is-referenced-by-count,references-count,URL,type",
    };
    if (filt.length) params.filter = filt.join(",");
    const sort = (filters || {}).sort;
    if (sort === "citations") { params.sort = "is-referenced-by-count"; params.order = "desc"; }
    else if (sort === "newest") { params.sort = "published"; params.order = "desc"; }
    const data = await get(`${BASE}/works`, { params: this.params(params), ttl: 3600 * 12 });
    return (((data || {}).message || {}).items || []).map(toPaper);
  }

  async paper(kind, value) {
    if (kind !== "doi") return null;
    const data = await get(`${BASE}/works/${value}`, { params: this.params(), ttl: 86400 * 7 });
    return data && data.message ? toPaper(data.message) : null;
  }

  async references(paper, limit = 200) {
    if (!paper.doi) return [];
    const full = await this.paper("doi", paper.doi);
    const dois = (full || {}).reference_dois || [];
    const out = [];
    for (const d of dois.slice(0, Math.min(limit, 60))) {
      const p = await this.paper("doi", d);
      if (p) out.push(p);
    }
    return out;
  }

  // Find the best matching real record for a title, or null when nothing matches well.
  async verify(title, authors = "", year = null) {
    const q = `${title} ${authors}`.trim();
    const data = await get(`${BASE}/works`, { params: this.params({ "query.bibliographic": q, rows: 3 }), ttl: 86400 * 7 });
    const items = ((data || {}).message || {}).items || [];
    const want = new Set(titleFingerprint(title).split(" ").filter(Boolean));
    let best = null;
    let bestScore = 0;
    for (const m of items) {
      const p = toPaper(m);
      const got = new Set(titleFingerprint(p.title).split(" ").filter(Boolean));
      if (!want.size || !got.size) continue;
      let inter = 0;
      for (const w of want) if (got.has(w)) inter++;
      let score = inter / Math.max(want.size + got.size - inter, 1);
      if (year && p.year && Math.abs(p.year - parseInt(year, 10)) > 1) score -= 0.4;
      if (score > bestScore) { best = p; bestScore = score; }
    }
    return bestScore >= 0.7 ? best : null;
  }
}
