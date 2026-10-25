// Test helpers: fresh storage and settings, a fetch mock, and the same OpenAlex fixture
// as tests/conftest.py work().
import { resetForTests } from "../engine/db.js";
import { resetDownHosts } from "../engine/net.js";
import { resetSettingsForTests } from "../engine/settings.js";

export function fresh(settings = {}) {
  resetForTests();
  resetSettingsForTests(settings);
  resetDownHosts();
}

export function work(wid, title, year, { cites = 10, refs = null, doi = null, abstract = "A study of concrete strength." } = {}) {
  const inv = {};
  abstract.split(" ").forEach((w, i) => { (inv[w] ||= []).push(i); });
  return {
    id: `https://openalex.org/${wid}`,
    doi: doi ? `https://doi.org/${doi}` : null,
    display_name: title,
    publication_year: year,
    authorships: [{ author: { display_name: "Rahim Uddin", id: "https://openalex.org/A1", orcid: "https://orcid.org/0000-0002-1825-0097" } }],
    primary_location: { source: { display_name: "Journal of Testing" }, landing_page_url: "https://x.org" },
    best_oa_location: { pdf_url: null },
    open_access: { oa_url: null },
    cited_by_count: cites,
    referenced_works_count: (refs || []).length,
    abstract_inverted_index: inv,
    ids: { openalex: `https://openalex.org/${wid}` },
    type: "article",
    referenced_works: (refs || []).map((r) => `https://openalex.org/${r}`),
    topics: [{ display_name: "Concrete" }],
  };
}

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

// routes: [[test(url, init) => bool, (url, init) => Response | Promise<Response> | throw]]
export function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const [test, respond] of routes) {
      if (test(url, init)) return respond(url, init);
    }
    return new Response("not found", { status: 404 });
  };
  return calls;
}

export const host = (h) => (url) => url.host === h;
