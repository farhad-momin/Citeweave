// Regression tests for bugs found while auditing the browser engine.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

import * as aggregator from "../engine/aggregator.js";
import * as ai from "../engine/ai.js";
import { papers as paperStore, records } from "../engine/db.js";
import * as jobs from "../engine/jobs.js";
import * as L from "../engine/library.js";
import { _resetForTests, handle } from "../engine/router.js";
import { toPaper as epmcPaper } from "../engine/sources/europepmc.js";
import * as S from "../engine/sources/index.js";
import relay from "../relay/worker.js";
import { fresh, host, json, mockFetch, work } from "./helpers.mjs";

function reset(settings = {}) {
  fresh(settings);
  L.resetLibraryForTests();
  _resetForTests();
}

const paper = (n, extra = {}) => ({ id: `doi:10.1234/p${n}`, doi: `10.1234/p${n}`, title: `Paper number ${n} on concrete`,
  year: 2020, authors: [{ name: "Rahim Uddin" }], abstract: `Abstract ${n}.`, ids: {}, sources: ["import"], ...extra });

test("Europe PMC records from PMC get their year from journalInfo or publication dates", () => {
  const a = epmcPaper({ source: "PMC", id: "PMC13670260", pmcid: "PMC13670260", title: "Live record",
    journalInfo: { yearOfPublication: 2026, dateOfPublication: "2026 Oct" }, firstPublicationDate: "2026-10-19", citedByCount: "0" });
  assert.equal(a.year, 2026);
  assert.equal(a.cited_by_count, 0);
  assert.equal(epmcPaper({ source: "PMC", id: "PMC1", title: "T", firstPublicationDate: "2025-01-02" }).year, 2025);
  assert.equal(epmcPaper({ source: "PMC", id: "PMC2", title: "T", electronicPublicationDate: "2024-05-06" }).year, 2024);
  assert.equal(epmcPaper({ source: "MED", id: "1", title: "T", pubYear: "2019", firstPublicationDate: "2018-12-30" }).year, 2019);
});

test("verification rejects a same-title record from the wrong year and falls back to OpenAlex", async () => {
  reset();
  mockFetch([
    [host("api.crossref.org"), () => json({ message: { items: [
      { DOI: "10.65215/r5bs2d54", title: ["Attention is all you need"], issued: { "date-parts": [[2025]] } },
    ] } })],
    [host("api.openalex.org"), () => json({ meta: {}, results: [
      work("W2626778328", "Attention Is All You Need", 2017, { doi: "10.48550/arxiv.1706.03762" }),
      work("W9", "Attention is all you need (repost)", 2025),
    ] })],
  ]);
  assert.equal(await S.crossref.verify("Attention is all you need", "Vaswani", 2017), null);
  const out = await ai.verifySuggestions([{ title: "Attention is all you need", first_author: "Vaswani", year: 2017 }]);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].year, 2017);
  assert.equal(out.results[0].verified, true);
  assert.deepEqual(out.rejected, []);
});

test("a running job is not forgotten after ten minutes, a finished one is", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let finish;
    const id = jobs.start("extract", () => new Promise((r) => { finish = r; }));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    mock.timers.tick(11 * 60 * 1000);
    assert.equal(jobs.get(id)?.status, "running");
    finish({ ok: true });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(jobs.get(id).status, "done");
    mock.timers.tick(11 * 60 * 1000);
    assert.equal(jobs.get(id), null);
  } finally {
    mock.timers.reset();
  }
});

test("sync import keeps a paper under its key even when the merge finds a DOI", async () => {
  reset();
  const c = await handle("POST", "/api/collections", { name: "Preprints" });
  const pre = { id: "arxiv:2101.00001", doi: null, title: "A preprint on concrete", year: 2021, authors: [], abstract: "", ids: { arxiv: "2101.00001" }, sources: ["arxiv"] };
  await handle("POST", `/api/collections/${c.id}/papers`, { papers: [pre] });
  const doc = await handle("GET", "/api/sync/export");
  doc.papers["arxiv:2101.00001"] = { ...pre, doi: "10.1000/pub", abstract: "Now published." };
  await handle("POST", "/api/sync/import", doc);
  const list = await handle("GET", `/api/collections/${c.id}/papers`);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "arxiv:2101.00001");
  assert.equal(list[0].abstract, "Now published.");
  await assert.rejects(handle("POST", "/api/sync/import", { ...doc, version: 2 }), /newer Citeweave/);
});

test("sync export carries the papers of notes, tags and history, and table rows from a chatbot", async () => {
  reset();
  // a paper opened and annotated but not in any collection
  await L.savePaper(paper(1));
  await handle("PUT", "/api/notes", { paper_id: paper(1).id, body: "note" });
  await L.savePaper(paper(2));
  await handle("PUT", "/api/tags", { paper_id: paper(2).id, tags: ["x"] });
  await handle("POST", "/api/history", { question: "Q?", answer: "A", papers: [paper(3)], mode: "extractive" });
  await handle("POST", "/api/tables", { name: "T", columns: [{ name: "Method" }],
    rows: [{ paper_id: paper(4).id, values: {}, paper: paper(4) }] });
  const doc = await handle("GET", "/api/sync/export");
  for (const n of [1, 2, 3, 4]) assert.ok(doc.papers[paper(n).id], `paper ${n} missing`);
  const table = Object.values(doc.records).find((r) => r.kind === "table");
  assert.deepEqual(table.data.paper_ids, [paper(4).id]);
  await assert.rejects(handle("POST", "/api/history", { question: "  ", answer: "" }), /question is required/);
});

test("library reads wait for the first load instead of seeing an empty library", async () => {
  reset();
  await records.put({ key: "collection:c1", kind: "collection", id: "c1", updated_at: 1, deleted: false, data: { name: "Saved", created_at: 1 } });
  L.resetLibraryForTests();
  const [a, b] = await Promise.all([L.listCollections(), L.listCollections()]);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
});

test("lookup keeps stored values that the new record lacks", async () => {
  reset();
  await paperStore.put({ ...paper(9, { doi: "10.1000/oa", id: "doi:10.1000/oa" }), abstract: "", oa_url: "https://repo.example/oa.pdf" });
  mockFetch([[host("api.openalex.org"), () => json(work("W9", "Paper number 9 on concrete", 2020, { doi: "10.1000/oa" }))]]);
  const p = await aggregator.lookup("doi", "10.1000/oa");
  assert.equal(p.ids.openalex, "W9");
  const stored = await paperStore.get("doi:10.1000/oa");
  assert.equal(stored.oa_url, "https://repo.example/oa.pdf");
  assert.equal(stored.ids.openalex, "W9");
});

test("GitHub sync: files over 1 MB, unicode, repository links and changes from another device", async () => {
  reset({ sync: { github: { token: "tok", repo: "https://github.com/me/data/", branch: "main", path: "sync/citeweave sync.json" } } });
  const remote = { format: "citeweave-sync", version: 1, records: {}, papers: { "doi:10.1/x": { id: "doi:10.1/x", title: "Dhaka ঢাকা: study" } } };
  const server = { sha: "sha1", content: Buffer.from(JSON.stringify(remote), "utf8").toString("base64") };
  const calls = mockFetch([[host("api.github.com"), (url, init) => {
    const method = init.method || "GET";
    if (url.pathname === "/repos/me/data/git/blobs/" + server.sha) return json({ sha: server.sha, content: server.content, encoding: "base64" });
    assert.equal(url.pathname, "/repos/me/data/contents/sync/citeweave%20sync.json");
    if (method === "GET") return json({ sha: server.sha, size: 2_000_000, content: "", encoding: "none", download_url: "https://raw.example/stale" });
    const body = JSON.parse(init.body);
    if (body.sha !== server.sha) return json({ message: "does not match" }, 409);
    server.content = body.content; server.sha = "sha-next";
    return json({ content: { sha: server.sha } });
  }]]);
  const r = await handle("POST", "/api/sync/github", { action: "read" });
  assert.equal(r.document.papers["doi:10.1/x"].title, "Dhaka ঢাকা: study");
  assert.ok(!calls.some((c) => c.url.host === "raw.example"), "stale raw link not used");
  // another device saves in the meantime: the write must not overwrite it
  server.sha = "sha-other";
  await assert.rejects(handle("POST", "/api/sync/github", { action: "write", document: r.document }), /changed on another device/);
  // after reading again the write goes through and keeps the unicode text
  const again = await handle("POST", "/api/sync/github", { action: "read" });
  const w = await handle("POST", "/api/sync/github", { action: "write", document: again.document });
  assert.equal(w.sha, "sha-next");
  assert.match(Buffer.from(server.content, "base64").toString("utf8"), /ঢাকা/);
  await assert.rejects(handle("POST", "/api/sync/github", { action: "write", document: { hello: 1 } }), /not a Citeweave sync file/);
});

test("relay forwards JSON POST requests (Semantic Scholar batch and recommendations)", async () => {
  const seen = [];
  globalThis.fetch = async (u, init = {}) => { seen.push({ u: String(u), init }); return json([{ paperId: "a", title: "T" }]); };
  const target = "https://api.semanticscholar.org/graph/v1/paper/batch?fields=title";
  const pre = await relay.fetch(new Request("https://relay.example/?url=" + encodeURIComponent(target), { method: "OPTIONS" }));
  assert.match(pre.headers.get("access-control-allow-methods"), /POST/);
  assert.match(pre.headers.get("access-control-allow-headers"), /content-type/);
  const res = await relay.fetch(new Request("https://relay.example/?url=" + encodeURIComponent(target), {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "k1" }, body: JSON.stringify({ ids: ["DOI:10.1/x"] }),
  }));
  assert.equal(res.status, 200);
  assert.equal(seen[0].u, target);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.body, JSON.stringify({ ids: ["DOI:10.1/x"] }));
  assert.equal(seen[0].init.headers.get("x-api-key"), "k1");
  const bad = await relay.fetch(new Request("https://relay.example/?url=" + encodeURIComponent("https://api.openalex.org/works")));
  assert.equal(bad.status, 403);
});

test("OpenCitations requests stay simple (no Authorization header) even with a token", async () => {
  reset({ sources: { opencitations: { key: "secret-token" } } });
  const calls = mockFetch([[host("api.opencitations.net"), () => json([{ cited: "omid:br/1 doi:10.1/A" }])]]);
  assert.deepEqual(await S.opencitations.referenceDois("10.1/x"), ["10.1/a"]);
  const headers = Object.keys(calls[0].init.headers || {}).map((h) => h.toLowerCase());
  assert.ok(!headers.includes("authorization"));
});

test("source parameters and parsing match the PC app", async () => {
  reset({ sources: { scopus: { enabled: true, key: "k" } } });
  const { toPaper: oaPaper } = await import("../engine/sources/openalex.js");
  const w = work("W1", "T", 2020);
  w.ids.pmcid = "https://www.ncbi.nlm.nih.gov/pmc/articles/5815332";
  assert.equal(oaPaper(w).ids.pmcid, "PMC5815332");

  const calls = mockFetch([
    [host("api.crossref.org"), () => json({ message: { items: [] } })],
    [host("www.ebi.ac.uk"), () => json({ resultList: { result: [] } })],
    [host("api.elsevier.com"), (u) => {
      const start = Number(u.searchParams.get("start"));
      const count = Number(u.searchParams.get("count"));
      const entry = Array.from({ length: Math.min(count, 30 - start) }, (_, i) => ({ "dc:title": `Scopus ${start + i}`, "prism:coverDate": "2020-01-01" }));
      return json({ "search-results": { "opensearch:totalResults": "30", entry } });
    }],
    [host("pub.orcid.org"), (u) => (u.pathname.endsWith("/person") ? json({ name: { "given-names": { value: "Rahim" }, "family-name": { value: "Uddin" } } })
      : json({ group: [{ "work-summary": [{ title: { title: { value: "A chapter" } }, type: "book-chapter", "external-ids": { "external-id": [
        { "external-id-type": "doi", "external-id-value": "10.1000/book", "external-id-relationship": "part-of" },
        { "external-id-type": "doi", "external-id-value": "10.1000/chapter", "external-id-relationship": "self" },
      ] } }] }] }))],
  ]);
  await S.crossref.search("concrete", 5);
  const sel = calls.find((c) => c.url.host === "api.crossref.org").url.searchParams.get("select").split(",");
  assert.ok(!sel.includes("published") && sel.includes("published-print") && sel.includes("published-online"));

  await S.europepmc.search("cement OR concrete", 5, { year_from: 2020, oa_only: true });
  const q = calls.find((c) => c.url.host === "www.ebi.ac.uk").url.searchParams.get("query");
  assert.equal(q, "(cement OR concrete) AND (PUB_YEAR:[2020 TO 2100]) AND OPEN_ACCESS:y");

  const [, works] = await S.scopus.authorWorks("123", 200);
  assert.equal(works.length, 30);

  const [, orcidWorks] = await S.orcid.works("0000-0002-1825-0097");
  assert.equal(orcidWorks[0].doi, "10.1000/chapter");
});

test("temperature 0 stays 0 and stored papers never keep interface fields", async () => {
  reset({ ai: { provider: "openai", temperature: 0, keys: { openai: "sk" } } });
  assert.equal(ai.activeConfig().temperature, 0);
  reset({ ai: { provider: "openai", temperature: "", keys: { openai: "sk" } } });
  assert.equal(ai.activeConfig().temperature, 0.2);

  reset();
  const shown = { ...paper(5), saved: true, note: "n", tags: ["t"], status: "read", apa: "x", key_sentence: "k",
    smart_score: 0.9, verified: true, from_page: true, bad_citations: [1], collections: ["c"], added_at: 1 };
  await L.savePaper(shown);
  const stored = await paperStore.get(paper(5).id);
  for (const k of L.UI_FIELDS) assert.ok(!(k in stored), `${k} stored`);
  // changing an object after saving it does not change what is stored
  shown.title = "changed";
  assert.equal((await paperStore.get(paper(5).id)).title, paper(5).title);
});
