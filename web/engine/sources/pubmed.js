// PubMed through NCBI E-utilities. No key needed; a free NCBI key raises the rate limit.
import { makePaper } from "../models.js";
import { get } from "../net.js";
import { Source, yearFilter } from "./base.js";
import { parseXml } from "./xml.js";

const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

export function parseEfetch(xmlText) {
  const out = [];
  let root;
  try {
    root = parseXml(xmlText);
  } catch {
    return out;
  }
  for (const art of root.descendants("PubmedArticle")) {
    const med = art.first("MedlineCitation");
    if (!med) continue;
    const a = med.first("Article");
    if (!a) continue;
    const titleNode = a.first("ArticleTitle");
    const title = titleNode ? titleNode.text() : "";
    const abstract = a.findAll("Abstract/AbstractText").map((t) => t.text()).join(" ");
    const journal = a.textOf("Journal/Title");
    const year = a.textOf("Journal/JournalIssue/PubDate/Year") ||
      a.textOf("Journal/JournalIssue/PubDate/MedlineDate").slice(0, 4);
    const authors = a.findAll("AuthorList/Author").map((au) => {
      const name = [au.textOf("ForeName"), au.textOf("LastName")].filter(Boolean).join(" ") || au.textOf("CollectiveName");
      let orcid = null;
      for (const ident of au.all("Identifier")) {
        if (ident.attr("Source") === "ORCID" && ident.text()) orcid = ident.text().replace(/\/+$/, "").split("/").pop();
      }
      return { name, orcid };
    });
    const ids = { pmid: med.textOf("PMID") || null };
    let doi = null;
    for (const aid of art.findAll("PubmedData/ArticleIdList/ArticleId")) {
      if (aid.attr("IdType") === "doi") doi = aid.text();
      else if (aid.attr("IdType") === "pmc") ids.pmcid = aid.text();
    }
    out.push(makePaper({
      source: "pubmed", title, doi, abstract, year, venue: journal, authors,
      url: `https://pubmed.ncbi.nlm.nih.gov/${ids.pmid}/`, ids,
      oa_url: ids.pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${ids.pmcid}/pdf/` : null,
    }));
  }
  return out;
}

export class PubMed extends Source {
  constructor() {
    super();
    this.name = "pubmed";
    this.label = "PubMed";
    this.homepage = "https://pubmed.ncbi.nlm.nih.gov";
    this.keyHelp = "Optional. A free NCBI API key raises the request rate.";
    this.capabilities = new Set(["search", "paper"]);
  }

  params(extra) {
    const p = { tool: "citeweave", ...extra };
    if (this.email()) p.email = this.email();
    if (this.key()) p.api_key = this.key();
    return p;
  }

  async fetch(pmids) {
    if (!pmids.length) return [];
    const text = await get(`${BASE}/efetch.fcgi`, {
      params: this.params({ db: "pubmed", id: pmids.join(","), retmode: "xml" }), parse: "text", ttl: 86400 * 7,
    });
    return parseEfetch(text || "");
  }

  async search(query, limit = 25, filters = null) {
    let term = query;
    const [y0, y1] = yearFilter(filters);
    if (y0 || y1) term += ` AND (${y0 || 1800}:${y1 || 3000}[pdat])`;
    if ((filters || {}).oa_only) term += " AND free full text[sb]";
    const sort = { newest: "pub_date" }[(filters || {}).sort || ""] || "relevance";
    const data = await get(`${BASE}/esearch.fcgi`, {
      params: this.params({ db: "pubmed", term, retmode: "json", retmax: Math.min(limit, 100), sort }),
      ttl: 3600 * 12,
    });
    const ids = ((data || {}).esearchresult || {}).idlist || [];
    return this.fetch(ids);
  }

  async paper(kind, value) {
    if (kind !== "pmid") return null;
    const rows = await this.fetch([value]);
    return rows.length ? rows[0] : null;
  }
}
