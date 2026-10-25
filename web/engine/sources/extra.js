// Smaller sources: Unpaywall, ORCID, CORE and Scopus.
import { makePaper, normalizeDoi } from "../models.js";
import { get } from "../net.js";
import { Source, yearFilter } from "./base.js";

// Finds legal open access copies of a DOI. Unpaywall asks for an email with each request.
export class Unpaywall extends Source {
  constructor() {
    super();
    this.name = "unpaywall";
    this.label = "Unpaywall";
    this.homepage = "https://unpaywall.org";
    this.capabilities = new Set(["oa_link"]);
  }

  ready() {
    if (!this.enabled()) return [false, "Unpaywall is turned off in Settings"];
    if (!this.email()) return [false, "Unpaywall needs your email address (Settings, General)"];
    return [true, ""];
  }

  async oaLink(doi) {
    const [ok] = this.ready();
    if (!ok || !doi) return null;
    const data = await get(`https://api.unpaywall.org/v2/${doi}`, { params: { email: this.email() }, ttl: 86400 * 7 });
    if (!data) return null;
    const best = data.best_oa_location || {};
    return {
      pdf: best.url_for_pdf,
      page: best.url_for_landing_page || best.url,
      version: best.version,
      license: best.license,
      status: data.oa_status,
    };
  }
}

// Public ORCID records. Reading public data needs no key.
export class Orcid extends Source {
  constructor() {
    super();
    this.name = "orcid";
    this.label = "ORCID";
    this.homepage = "https://orcid.org";
    this.capabilities = new Set(["author"]);
  }

  enabled() { return true; }

  // returns [info, works]
  async works(orcid) {
    const headers = { Accept: "application/json" };
    const person = await get(`https://pub.orcid.org/v3.0/${orcid}/person`, { headers, ttl: 86400 });
    const data = await get(`https://pub.orcid.org/v3.0/${orcid}/works`, { headers, ttl: 86400 });
    if (data === null && person === null) return [null, []];
    let name = "";
    if (person) {
      const n = person.name || {};
      const given = (n["given-names"] || {}).value || "";
      const family = (n["family-name"] || {}).value || "";
      name = `${given} ${family}`.trim();
    }
    const works = [];
    for (const g of (data || {}).group || []) {
      const s = (g["work-summary"] || [{}])[0] || {};
      const ext = (s["external-ids"] || {})["external-id"] || [];
      let doi = null;
      const ids = {};
      for (const e of ext) {
        // "part-of" ids belong to the book or journal, not this work
        if (String(e["external-id-relationship"] || "self").toLowerCase() !== "self") continue;
        const t = String(e["external-id-type"] || "").toLowerCase();
        const v = e["external-id-value"];
        if (t === "doi") doi = normalizeDoi(v);
        else if (["arxiv", "pmid", "pmc"].includes(t)) ids[t === "pmc" ? "pmcid" : t] = v;
      }
      const title = ((s.title || {}).title || {}).value || "";
      const year = ((s["publication-date"] || {}).year || {}).value;
      const venue = (s["journal-title"] || {}).value || "";
      works.push(makePaper({ source: "orcid", title, doi, year, venue, type: s.type, ids }));
    }
    return [{ name, orcid, works_count: works.length }, works];
  }
}

// CORE aggregates open access research outputs from repositories. Free key required.
export class Core extends Source {
  constructor() {
    super();
    this.name = "core";
    this.label = "CORE";
    this.homepage = "https://core.ac.uk";
    this.keyRequired = true;
    this.keyHelp = "Register for a free key at core.ac.uk/services/api.";
    this.capabilities = new Set(["search"]);
  }

  async search(query, limit = 25, filters = null) {
    let q = query;
    const [y0, y1] = yearFilter(filters);
    if (y0) q += ` AND yearPublished>=${parseInt(y0, 10)}`;
    if (y1) q += ` AND yearPublished<=${parseInt(y1, 10)}`;
    const data = await get("https://api.core.ac.uk/v3/search/works", {
      params: { q, limit: Math.min(limit, 100) }, headers: { Authorization: `Bearer ${this.key()}` }, ttl: 3600 * 12,
    });
    return ((data || {}).results || []).map((r) => makePaper({
      source: "core", title: r.title, doi: r.doi, abstract: r.abstract,
      year: r.yearPublished, venue: r.publisher || "",
      authors: (r.authors || []).map((a) => ({ name: a.name || "" })),
      cited_by_count: r.citationCount, oa_url: r.downloadUrl,
      url: r.links && r.links.length ? (r.links[0] || {}).url : null,
      ids: { core: r.id ? String(r.id) : null },
    }));
  }
}

// Elsevier Scopus. Needs the researcher's own key, and usually their institution's network.
export class Scopus extends Source {
  constructor() {
    super();
    this.name = "scopus";
    this.label = "Scopus";
    this.homepage = "https://dev.elsevier.com";
    this.keyRequired = true;
    this.keyHelp = "Get a key at dev.elsevier.com. Full access usually requires your institution's network.";
    this.capabilities = new Set(["search", "author"]);
  }

  headers() {
    const h = { "X-ELS-APIKey": this.key(), Accept: "application/json" };
    const token = String(this.cfg().insttoken || "").trim();
    if (token) h["X-ELS-Insttoken"] = token;
    return h;
  }

  static toPaper(e) {
    return makePaper({
      source: "scopus", title: e["dc:title"], doi: e["prism:doi"],
      abstract: e["dc:description"], year: String(e["prism:coverDate"] || "").slice(0, 4),
      venue: e["prism:publicationName"],
      authors: e["dc:creator"] ? [{ name: e["dc:creator"] }] : [],
      cited_by_count: e["citedby-count"],
      ids: { scopus: String(e["dc:identifier"] || "").replace("SCOPUS_ID:", "") || null, pmid: e["pubmed-id"] },
    });
  }

  // The standard view returns at most 25 records per request, so page with `start`.
  async _search(query, limit) {
    const out = [];
    let start = 0;
    while (out.length < limit) {
      const data = await get("https://api.elsevier.com/content/search/scopus", {
        params: { query, count: Math.min(limit - out.length, 25), start }, headers: this.headers(), ttl: 3600 * 12,
      });
      const results = (data || {})["search-results"] || {};
      const entries = (results.entry || []).filter((e) => !e.error);
      out.push(...entries.map((e) => Scopus.toPaper(e)));
      start += entries.length;
      const total = parseInt(results["opensearch:totalResults"], 10) || 0;
      if (!entries.length || start >= total) break;
    }
    return out.slice(0, limit);
  }

  async search(query, limit = 25, filters = null) {
    let q = `TITLE-ABS-KEY(${query})`;
    const [y0, y1] = yearFilter(filters);
    if (y0) q += ` AND PUBYEAR > ${parseInt(y0, 10) - 1}`;
    if (y1) q += ` AND PUBYEAR < ${parseInt(y1, 10) + 1}`;
    return this._search(q, limit);
  }

  // returns [info, works]
  async authorWorks(authorId, limit = 200) {
    const works = await this._search(`AU-ID(${authorId})`, limit);
    return [{ scopus: authorId, works_count: works.length }, works];
  }
}
