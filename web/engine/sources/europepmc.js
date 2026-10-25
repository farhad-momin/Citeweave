// Europe PMC: life science literature including PubMed, preprints and open full text. No key.
import { makePaper } from "../models.js";
import { get } from "../net.js";
import { Source, yearFilter } from "./base.js";

const BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";

export function toPaper(r) {
  let oa = null;
  for (const u of ((r.fullTextUrlList || {}).fullTextUrl || [])) {
    if (u.documentStyle === "pdf" && ["OA", "F"].includes(u.availabilityCode)) { oa = u.url; break; }
  }
  let authors = ((r.authorList || {}).author || []).map((a) => ({
    name: a.fullName || "",
    orcid: (a.authorId || {}).type === "ORCID" ? (a.authorId || {}).value : null,
  }));
  if (!authors.length && r.authorString) {
    authors = r.authorString.replace(/\.+$/, "").split(",").map((n) => n.trim()).filter(Boolean).map((name) => ({ name }));
  }
  const pmcid = r.pmcid;
  if (!oa && pmcid && r.isOpenAccess === "Y") oa = `https://europepmc.org/articles/${pmcid}?pdf=render`;
  return makePaper({
    source: "europepmc",
    title: r.title,
    doi: r.doi,
    abstract: r.abstractText,
    // PMC records carry no pubYear, only journalInfo and publication dates
    year: r.pubYear || (r.journalInfo || {}).yearOfPublication ||
      String(r.firstPublicationDate || "").slice(0, 4) || String(r.electronicPublicationDate || "").slice(0, 4) || null,
    venue: r.journalTitle || (((r.journalInfo || {}).journal || {}).title),
    authors,
    cited_by_count: r.citedByCount,
    oa_url: oa,
    url: r.id ? `https://europepmc.org/article/${r.source || "MED"}/${r.id}` : null,
    type: (((r.pubTypeList || {}).pubType) || [null])[0],
    ids: { pmid: r.pmid, pmcid },
  });
}

export class EuropePMC extends Source {
  constructor() {
    super();
    this.name = "europepmc";
    this.label = "Europe PMC";
    this.homepage = "https://europepmc.org";
    this.capabilities = new Set(["search", "paper"]);
  }

  async search(query, limit = 25, filters = null) {
    // brackets keep "a OR b" together, so the filters below apply to the whole query
    let q = `(${query})`;
    const [y0, y1] = yearFilter(filters);
    if (y0 || y1) q += ` AND (PUB_YEAR:[${y0 || 1800} TO ${y1 || 2100}])`;
    if ((filters || {}).oa_only) q += " AND OPEN_ACCESS:y";
    const sort = (filters || {}).sort;
    const params = { query: q, format: "json", resultType: "core", pageSize: Math.min(limit, 100) };
    if (sort === "citations") params.sort = "CITED desc";
    else if (sort === "newest") params.sort = "P_PDATE_D desc";
    const data = await get(`${BASE}/search`, { params, ttl: 3600 * 12 });
    return (((data || {}).resultList || {}).result || []).map(toPaper);
  }

  async paper(kind, value) {
    const field = { doi: "DOI", pmid: "EXT_ID", pmcid: "PMCID" }[kind];
    if (!field) return null;
    const q = `${field}:"${value}"` + (kind === "pmid" ? " AND SRC:MED" : "");
    const data = await get(`${BASE}/search`, {
      params: { query: q, format: "json", resultType: "core", pageSize: 1 }, ttl: 86400 * 7,
    });
    const rows = ((data || {}).resultList || {}).result || [];
    return rows.length ? toPaper(rows[0]) : null;
  }
}
