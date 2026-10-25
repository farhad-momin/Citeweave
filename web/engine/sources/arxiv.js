// arXiv preprints. No key. arXiv asks for at most one request every 3 seconds.
import { makePaper } from "../models.js";
import { get } from "../net.js";
import { Source, yearFilter } from "./base.js";
import { parseXml } from "./xml.js";

const BASE = "https://export.arxiv.org/api/query";

export function parseFeed(xmlText) {
  const out = [];
  let root;
  try {
    root = parseXml(xmlText);
  } catch {
    return out;
  }
  const feed = root.descendants("feed")[0] || root;
  for (const e of feed.all("entry")) {
    const rawId = e.textOf("id").trim();
    const m = rawId.match(/abs\/(.+?)(v\d+)?$/);
    if (!m) continue;
    const arxivId = m[1];
    let pdf = null;
    for (const link of e.all("link")) if (link.attr("title") === "pdf") pdf = link.attr("href");
    const doiNode = e.first("arxiv:doi");
    const journal = e.textOf("arxiv:journal_ref");
    const cat = e.first("arxiv:primary_category");
    out.push(makePaper({
      source: "arxiv",
      title: e.textOf("title"),
      doi: doiNode ? doiNode.text() : null,
      abstract: e.textOf("summary"),
      year: e.textOf("published").slice(0, 4),
      venue: journal || "arXiv",
      authors: e.all("author").map((a) => ({ name: a.textOf("name").trim() })),
      oa_url: pdf || `https://arxiv.org/pdf/${arxivId}`,
      url: `https://arxiv.org/abs/${arxivId}`,
      type: "preprint",
      topics: cat && cat.attr("term") ? [cat.attr("term")] : [],
      ids: { arxiv: arxivId },
    }));
  }
  return out;
}

export class Arxiv extends Source {
  constructor() {
    super();
    this.name = "arxiv";
    this.label = "arXiv";
    this.homepage = "https://arxiv.org";
    this.capabilities = new Set(["search", "paper"]);
  }

  async search(query, limit = 25, filters = null) {
    const words = (String(query).match(/[\p{L}\p{N}_-]+/gu) || []).slice(0, 12);
    let terms = words.map((w) => `all:${w}`).join(" AND ") || `all:${query}`;
    const [y0, y1] = yearFilter(filters);
    if (y0 || y1) terms += ` AND submittedDate:[${y0 || 1990}01010000 TO ${y1 || 2100}12312359]`;
    const text = await get(BASE, {
      params: { search_query: terms, start: 0, max_results: Math.min(limit, 100), sortBy: "relevance" },
      parse: "text",
      ttl: 3600 * 12,
    });
    return parseFeed(text || "");
  }

  async paper(kind, value) {
    if (kind !== "arxiv") return null;
    const text = await get(BASE, { params: { id_list: value }, parse: "text", ttl: 86400 * 7 });
    const papers = parseFeed(text || "");
    return papers.length ? papers[0] : null;
  }
}
