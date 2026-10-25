// Semantic Scholar Academic Graph (Allen Institute for AI). Free; without a key requests
// share a public pool. Provides short TLDR summaries and a recommendations endpoint.
import { makePaper } from "../models.js";
import { get, post } from "../net.js";
import { Source, uniq, yearFilter } from "./base.js";

const GRAPH = "https://api.semanticscholar.org/graph/v1";
const RECS = "https://api.semanticscholar.org/recommendations/v1";
const FIELDS = "title,abstract,year,venue,authors,citationCount,referenceCount,externalIds," +
  "openAccessPdf,tldr,url,publicationTypes,fieldsOfStudy";
const FIELDS_LITE = "title,abstract,year,venue,authors,citationCount,referenceCount,externalIds,openAccessPdf,url";

export function toPaper(p) {
  if (!p || !p.title) return null;
  const ext = p.externalIds || {};
  const oa = p.openAccessPdf || {};
  return makePaper({
    source: "semanticscholar",
    title: p.title,
    doi: ext.DOI,
    abstract: p.abstract,
    year: p.year,
    venue: p.venue,
    authors: (p.authors || []).map((a) => ({ name: a.name || "", s2: a.authorId })),
    cited_by_count: p.citationCount,
    reference_count: p.referenceCount,
    oa_url: oa.url || null,
    url: p.url,
    type: (p.publicationTypes || [null])[0],
    tldr: p.tldr && typeof p.tldr === "object" ? p.tldr.text : null,
    topics: p.fieldsOfStudy || [],
    ids: {
      s2: p.paperId,
      arxiv: ext.ArXiv,
      pmid: ext.PubMed,
      pmcid: ext.PubMedCentral ? "PMC" + String(ext.PubMedCentral) : null,
      corpus: ext.CorpusId,
    },
  });
}

export class SemanticScholar extends Source {
  constructor() {
    super();
    this.name = "semanticscholar";
    this.label = "Semantic Scholar";
    this.homepage = "https://www.semanticscholar.org";
    this.keyHelp = "Optional. Request a free key at semanticscholar.org/product/api for a steady rate.";
    this.capabilities = new Set(["search", "paper", "references", "citations", "recommend", "author"]);
  }

  headers() { return this.key() ? { "x-api-key": this.key() } : {}; }

  static s2Id(kind, value) {
    return {
      doi: `DOI:${value}`,
      arxiv: `ARXIV:${value}`,
      pmid: `PMID:${value}`,
      pmcid: `PMCID:${String(value).replace("PMC", "")}`,
      s2: value,
    }[kind] || null;
  }

  idFor(paper) {
    const ids = paper.ids || {};
    if (ids.s2) return ids.s2;
    if (paper.doi) return `DOI:${paper.doi}`;
    if (ids.arxiv) return `ARXIV:${ids.arxiv}`;
    if (ids.pmid) return `PMID:${ids.pmid}`;
    return null;
  }

  async search(query, limit = 25, filters = null) {
    const params = { query, limit: Math.min(limit, 100), fields: FIELDS };
    const [y0, y1] = yearFilter(filters);
    if (y0 || y1) params.year = `${y0 || ""}-${y1 || ""}`;
    const data = await get(`${GRAPH}/paper/search`, { params, headers: this.headers(), ttl: 3600 * 12 });
    let papers = ((data || {}).data || []).map(toPaper).filter(Boolean);
    if ((filters || {}).oa_only) papers = papers.filter((p) => p.oa_url);
    return papers;
  }

  async paper(kind, value) {
    const sid = SemanticScholar.s2Id(kind, value);
    if (!sid) return null;
    const data = await get(`${GRAPH}/paper/${sid}`, { params: { fields: FIELDS }, headers: this.headers(), ttl: 86400 * 7 });
    return data ? toPaper(data) : null;
  }

  async batch(ids) {
    const out = [];
    const list = uniq(ids);
    for (let i = 0; i < list.length; i += 400) {
      const data = await post(`${GRAPH}/paper/batch`, {
        params: { fields: FIELDS_LITE }, json: { ids: list.slice(i, i + 400) }, headers: this.headers(), ttl: 86400 * 7,
      });
      out.push(...(data || []).filter(Boolean).map(toPaper).filter(Boolean));
    }
    return out;
  }

  async _edges(paper, kind, limit) {
    const sid = this.idFor(paper);
    if (!sid) return [];
    const key = kind === "references" ? "citedPaper" : "citingPaper";
    const out = [];
    let offset = 0;
    while (out.length < limit) {
      const page = Math.min(100, limit - out.length);
      const data = await get(`${GRAPH}/paper/${sid}/${kind}`, {
        params: { fields: FIELDS_LITE, limit: page, offset }, headers: this.headers(), ttl: 86400,
      });
      const rows = (data || {}).data || [];
      out.push(...rows.map((r) => toPaper(r[key] || {})).filter(Boolean));
      if (!data || data.next === undefined || data.next === null || !rows.length) break;
      offset = data.next;
    }
    return out;
  }

  async references(paper, limit = 200) { return this._edges(paper, "references", limit); }
  async citations(paper, limit = 200) { return this._edges(paper, "citations", limit); }

  async recommend(papers, negative = null, limit = 30) {
    const pos = papers.map((p) => this.idFor(p)).filter(Boolean);
    const neg = (negative || []).map((p) => this.idFor(p)).filter(Boolean);
    if (!pos.length) return [];
    const data = await post(`${RECS}/papers`, {
      params: { fields: FIELDS_LITE, limit: Math.min(limit, 100) },
      json: { positivePaperIds: pos.slice(0, 100), negativePaperIds: neg.slice(0, 100) },
      headers: this.headers(),
      ttl: 86400,
    });
    return ((data || {}).recommendedPapers || []).map(toPaper).filter(Boolean);
  }

  // returns [info, works]
  async authorWorks(authorId, limit = 500) {
    const info = await get(`${GRAPH}/author/${authorId}`, {
      params: { fields: "name,paperCount,citationCount,hIndex,affiliations" }, headers: this.headers(), ttl: 86400,
    });
    if (!info) return [null, []];
    const data = await get(`${GRAPH}/author/${authorId}/papers`, {
      params: { fields: FIELDS_LITE, limit: Math.min(limit, 1000) }, headers: this.headers(), ttl: 86400,
    });
    const works = ((data || {}).data || []).map(toPaper).filter(Boolean);
    return [{
      name: info.name,
      s2: authorId,
      works_count: info.paperCount,
      cited_by_count: info.citationCount,
      h_index: info.hIndex,
      institution: (info.affiliations || []).join(", "),
    }, works];
  }
}
