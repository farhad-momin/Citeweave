// OpenCitations Index: open DOI to DOI citation links (CC0). No key needed. Used as a
// backup for reference and citation lists; returns DOIs only.
import { get } from "../net.js";
import { Source } from "./base.js";

const BASE = "https://api.opencitations.net/index/v2";

function doiFrom(ids) {
  const m = String(ids || "").match(/doi:(\S+)/);
  return m ? m[1].toLowerCase() : null;
}

export class OpenCitations extends Source {
  constructor() {
    super();
    this.name = "opencitations";
    this.label = "OpenCitations";
    this.homepage = "https://opencitations.net";
    this.keyHelp = "Optional. An access token from opencitations.net helps them count usage. The web version does not send it, so requests stay simple for the browser.";
    this.capabilities = new Set(["reference_dois", "citation_dois"]);
  }

  // The token is not sent from the browser: an Authorization header turns these simple GET
  // requests into CORS preflight requests, which would put a working service at risk.
  headers() { return {}; }

  async referenceDois(doi) {
    const data = await get(`${BASE}/references/doi:${doi}`, { headers: this.headers(), ttl: 86400 * 7 });
    return (data || []).map((r) => doiFrom(r.cited)).filter(Boolean);
  }

  async citationDois(doi) {
    const data = await get(`${BASE}/citations/doi:${doi}`, { headers: this.headers(), ttl: 86400 });
    return (data || []).map((r) => doiFrom(r.citing)).filter(Boolean);
  }
}
