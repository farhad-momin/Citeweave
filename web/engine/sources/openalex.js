// OpenAlex: open catalogue of scholarly works (CC0 data). Works without a key on a small
// daily allowance; a free key raises it. Lookups by id or DOI are the cheapest calls.
import { abstractFromInvertedIndex, makePaper } from "../models.js";
import { get } from "../net.js";
import { Source, uniq, yearFilter } from "./base.js";

export const BASE = "https://api.openalex.org";
const SELECT = [
  "id", "doi", "display_name", "publication_year", "authorships", "primary_location",
  "best_oa_location", "open_access", "cited_by_count", "referenced_works_count",
  "abstract_inverted_index", "ids", "type", "referenced_works", "topics",
].join(",");

export function shortId(urlOrId) {
  if (!urlOrId) return null;
  return String(urlOrId).replace(/\/+$/, "").split("/").pop();
}

export function toPaper(w) {
  const ids = w.ids || {};
  const loc = w.primary_location || {};
  const src = loc.source || {};
  const best = w.best_oa_location || {};
  const oaUrl = best.pdf_url || (w.open_access || {}).oa_url;
  // OpenAlex gives .../pmc/articles/5815332; elsewhere it is PMC5815332
  let pmcid = shortId(ids.pmcid);
  if (pmcid && /^\d+$/.test(pmcid)) pmcid = "PMC" + pmcid;
  const authors = (w.authorships || []).map((a) => {
    const au = a.author || {};
    return { name: au.display_name || a.raw_author_name || "", orcid: shortId(au.orcid), openalex: shortId(au.id) };
  });
  return makePaper({
    source: "openalex",
    title: w.display_name || w.title,
    doi: w.doi,
    abstract: abstractFromInvertedIndex(w.abstract_inverted_index),
    year: w.publication_year,
    venue: src.display_name,
    authors,
    cited_by_count: w.cited_by_count,
    reference_count: w.referenced_works_count,
    oa_url: oaUrl,
    url: loc.landing_page_url,
    type: w.type,
    topics: (w.topics || []).slice(0, 3).map((t) => t.display_name).filter(Boolean),
    ids: { openalex: shortId(w.id), pmid: shortId(ids.pmid), pmcid },
    references: (w.referenced_works || []).map(shortId),
  });
}

export class OpenAlex extends Source {
  constructor() {
    super();
    this.name = "openalex";
    this.label = "OpenAlex";
    this.homepage = "https://openalex.org";
    this.keyHelp = "Optional. A free key from openalex.org (Settings, API) gives a 10x larger daily allowance.";
    this.capabilities = new Set(["search", "paper", "references", "citations", "author", "related"]);
  }

  params(extra = {}) {
    const p = { ...extra };
    if (this.key()) p.api_key = this.key();
    if (this.email()) p.mailto = this.email();
    return p;
  }

  async _works(params, ttl = 86400, signal) {
    const data = await get(`${BASE}/works`, { params: this.params({ select: SELECT, ...params }), ttl, signal });
    return ((data || {}).results || []).map(toPaper);
  }

  async search(query, limit = 25, filters = null) {
    const filt = [];
    const [y0, y1] = yearFilter(filters);
    if (y0) filt.push(`from_publication_date:${parseInt(y0, 10)}-01-01`);
    if (y1) filt.push(`to_publication_date:${parseInt(y1, 10)}-12-31`);
    if ((filters || {}).oa_only) filt.push("is_oa:true");
    const params = { search: query, per_page: Math.min(limit, 100) };
    if (filt.length) params.filter = filt.join(",");
    const sort = (filters || {}).sort;
    if (sort === "citations") params.sort = "cited_by_count:desc";
    else if (sort === "newest") params.sort = "publication_date:desc";
    return this._works(params, 3600 * 12);
  }

  async paper(kind, value, signal) {
    const path = {
      doi: `doi:${value}`,
      openalex: value,
      pmid: `pmid:${value}`,
      pmcid: `pmcid:${value}`,
      arxiv: `doi:10.48550/arxiv.${value}`,
    }[kind];
    if (!path) return null;
    const data = await get(`${BASE}/works/${path}`, { params: this.params({ select: SELECT }), ttl: 86400 * 7, signal });
    return data ? toPaper(data) : null;
  }

  // Fetch many works by OpenAlex id, 50 per request.
  async batch(openalexIds, signal) {
    const out = [];
    const ids = uniq(openalexIds);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      out.push(...await this._works({ filter: "ids.openalex:" + chunk.join("|"), per_page: 50 }, 86400 * 7, signal));
    }
    return out;
  }

  async batchDois(dois, signal) {
    const out = [];
    const ids = uniq(dois);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      out.push(...await this._works({ filter: "doi:" + chunk.join("|"), per_page: 50 }, 86400 * 7, signal));
    }
    return out;
  }

  async _ensure(paper, signal) {
    if ((paper.ids || {}).openalex) return paper;
    if (paper.doi) return this.paper("doi", paper.doi, signal);
    return null;
  }

  async references(paper, limit = 200, signal) {
    const p = await this._ensure(paper, signal);
    if (!p) return [];
    let refs = p.references;
    if (refs === undefined || refs === null) {
      const full = await this.paper("openalex", p.ids.openalex, signal);
      refs = (full || {}).references || [];
    }
    return this.batch(refs.slice(0, limit), signal);
  }

  async citations(paper, limit = 200, since = null, signal) {
    const p = await this._ensure(paper, signal);
    if (!p) return [];
    let filt = `cites:${p.ids.openalex}`;
    if (since) filt += `,from_publication_date:${since}`;
    const out = [];
    let cursor = "*";
    while (out.length < limit && cursor) {
      const data = await get(`${BASE}/works`, {
        params: this.params({
          select: SELECT, filter: filt, per_page: Math.min(100, limit), sort: "cited_by_count:desc", cursor,
        }),
        ttl: 86400,
        signal,
      });
      if (!data) break;
      out.push(...(data.results || []).map(toPaper));
      cursor = (data.meta || {}).next_cursor;
      if (!(data.results || []).length) break;
    }
    return out.slice(0, limit);
  }

  // Works citing any of the given ids, published on or after `since` (YYYY-MM-DD).
  async citedByAny(openalexIds, since, limit = 200) {
    const out = [];
    const ids = openalexIds.filter(Boolean);
    for (let i = 0; i < ids.length; i += 50) {
      const filt = "cites:" + ids.slice(i, i + 50).join("|") + `,from_publication_date:${since}`;
      out.push(...await this._works({ filter: filt, per_page: 100, sort: "publication_date:desc" }, 3600));
    }
    return out.slice(0, limit);
  }

  async related(paper, limit = 20) {
    const p = await this._ensure(paper);
    if (!p) return [];
    const data = await get(`${BASE}/works/${p.ids.openalex}`, { params: this.params({ select: "related_works" }), ttl: 86400 * 7 });
    const rel = ((data || {}).related_works || []).map(shortId);
    return this.batch(rel.slice(0, limit));
  }

  // returns [info, works]
  async authorWorks({ orcid = null, authorId = null, limit = 500 } = {}) {
    let author;
    if (orcid && !authorId) {
      const a = await get(`${BASE}/authors/orcid:${orcid}`, { params: this.params(), ttl: 86400 });
      if (!a) return [null, []];
      authorId = shortId(a.id);
      author = a;
    } else {
      author = await get(`${BASE}/authors/${authorId}`, { params: this.params(), ttl: 86400 });
    }
    if (!author) return [null, []];
    const out = [];
    let cursor = "*";
    while (cursor && out.length < limit) {
      const data = await get(`${BASE}/works`, {
        params: this.params({
          select: SELECT, filter: `author.id:${authorId}`, per_page: 100, sort: "publication_year:desc", cursor,
        }),
        ttl: 86400,
      });
      if (!data || !(data.results || []).length) break;
      out.push(...data.results.map(toPaper));
      cursor = (data.meta || {}).next_cursor;
    }
    const info = {
      name: author.display_name,
      openalex: shortId(author.id),
      orcid: shortId(author.orcid),
      works_count: author.works_count,
      cited_by_count: author.cited_by_count,
      h_index: (author.summary_stats || {}).h_index,
      institution: (((author.last_known_institutions || [{}])[0]) || {}).display_name,
    };
    return [info, out];
  }

  async autocomplete(q) {
    const data = await get(`${BASE}/autocomplete/works`, { params: this.params({ q }), ttl: 3600 });
    return ((data || {}).results || []).map((r) => ({ title: r.display_name, hint: r.hint, openalex: shortId(r.id) }));
  }
}
