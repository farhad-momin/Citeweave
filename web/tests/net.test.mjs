import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import * as aggregator from "../engine/aggregator.js";
import { buildMap } from "../engine/graph.js";
import { hostDown, request, SourceError } from "../engine/net.js";
import { resetSettingsForTests } from "../engine/settings.js";
import { fresh, host, json, mockFetch, work } from "./helpers.mjs";

const OA = "api.openalex.org";
const S2 = "api.semanticscholar.org";

beforeEach(() => fresh());

test("search falls back when the first source is busy", async () => {
  const calls = mockFetch([
    [host(OA), () => new Response("busy", { status: 503 })],
    [host("api.crossref.org"), () => json({ message: { items: [
      { DOI: "10.1000/rac", title: ["Recycled aggregate concrete"], issued: { "date-parts": [[2020]] }, author: [{ given: "A", family: "B" }] },
    ] } })],
  ]);
  // keep retries short: Retry-After of 0 seconds
  globalThis.fetch = ((orig) => async (u, i) => {
    const r = await orig(u, i);
    if (r.status === 503) return new Response("busy", { status: 503, headers: { "retry-after": "0" } });
    return r;
  })(globalThis.fetch);
  const r = await aggregator.search("recycled concrete");
  // Semantic Scholar refuses web pages, so it is skipped without a relay and Crossref answers
  assert.deepEqual(r.used, ["crossref"]);
  assert.ok("openalex" in r.errors);
  assert.equal(r.results[0].doi, "10.1000/rac");
  assert.equal(calls.filter((c) => c.url.host === OA).length, 3, "OpenAlex tried with retries");
});

test("offline: a refused connection fails fast and the host is skipped for a while", async () => {
  let n = 0;
  globalThis.fetch = async () => { n++; throw new TypeError("Failed to fetch"); };
  const t0 = Date.now();
  await assert.rejects(request("GET", "https://api.openalex.org/works", { params: { search: "x" } }),
    (e) => e instanceof SourceError && /could not be reached from this page/.test(e.message));
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(n, 1, "no retries after a connection failure");
  assert.ok(hostDown(OA));
  await assert.rejects(request("GET", "https://api.openalex.org/works", { params: { search: "y" } }), SourceError);
  assert.equal(n, 1, "second call does not touch the network");
});

test("cache: repeat requests are served locally and secrets stay out of the key", async () => {
  let n = 0;
  globalThis.fetch = async () => { n++; return json({ ok: n }); };
  const a = await request("GET", "https://api.crossref.org/works", { params: { query: "x", api_key: "one" } });
  const b = await request("GET", "https://api.crossref.org/works", { params: { query: "x", api_key: "two" } });
  assert.deepEqual(a, { ok: 1 });
  assert.deepEqual(b, { ok: 1 });
  assert.equal(n, 1);
});

test("404 means not found, other errors explain themselves", async () => {
  globalThis.fetch = async (u) => (String(u).includes("missing")
    ? new Response("", { status: 404 })
    : new Response("bad key", { status: 401 }));
  assert.equal(await request("GET", "https://api.crossref.org/missing", { ttl: 0 }), null);
  await assert.rejects(request("GET", "https://api.crossref.org/works", { ttl: 0 }),
    (e) => e instanceof SourceError && e.message === "api.crossref.org answered 401: bad key");
});

test("relay is used only for listed hosts", async () => {
  resetSettingsForTests({ relay: { url: "https://relay.example.workers.dev/" } });
  const seen = [];
  globalThis.fetch = async (u) => { seen.push(String(u)); return new Response("<feed></feed>", { status: 200 }); };
  await request("GET", "https://export.arxiv.org/api/query", { params: { id_list: "2101.00001" }, parse: "text", ttl: 0 });
  await request("GET", "https://api.crossref.org/works", { params: { query: "x" }, ttl: 0, parse: "text" });
  assert.equal(seen[0], "https://relay.example.workers.dev/?url=" + encodeURIComponent("https://export.arxiv.org/api/query?id_list=2101.00001"));
  assert.equal(seen[1], "https://api.crossref.org/works?query=x");
});

test("citation map end to end with mocked OpenAlex", async () => {
  const seed = work("S", "Seed paper", 2015, { refs: ["A", "B"], doi: "10.1000/seed" });
  const a = work("A", "Paper A", 2010);
  const b = work("B", "Paper B", 2011);
  const d = work("D", "Citer D", 2019, { refs: ["S", "A", "B"] });
  const pool = { A: a, B: b, S: seed, D: d };
  mockFetch([
    [(u) => u.host === OA && u.pathname === "/works", (u) => {
      const f = u.searchParams.get("filter") || "";
      if (f.startsWith("ids.openalex:")) return json({ results: f.split(":")[1].split("|").filter((i) => pool[i]).map((i) => pool[i]), meta: {} });
      if (f.startsWith("cites:S")) return json({ results: [d], meta: { next_cursor: null } });
      return json({ results: [seed], meta: {} });
    }],
    [(u) => u.host === OA && u.pathname.startsWith("/works/doi:"), () => json(seed)],
    [host(S2), () => new Response("", { status: 404 })],
  ]);
  const sp = await aggregator.resolve("10.1000/seed");
  assert.equal(sp.ids.openalex, "S");
  const steps = [];
  const res = await buildMap([sp], { maxNodes: 10, progress: (m) => steps.push(m) });
  assert.deepEqual(new Set(res.nodes.map((n) => n.key)), new Set(["S", "A", "B", "D"]));
  assert.ok(res.edges.some((e) => e.source === "D" && e.target === "S"));
  assert.ok(res.edges.some((e) => e.source === "S" && e.target === "A"));
  assert.equal(res.stats.candidates, 3);
  assert.equal(res.nodes.find((n) => n.key === "S").seed, true);
  assert.ok(res.nodes.every((n) => typeof n.importance === "number"));
  assert.equal(steps.at(-1), "Done");
  assert.ok(Array.isArray(res.more) && Array.isArray(res.foundational) && Array.isArray(res.newer));
});

test("lookup falls through the chain and merges", async () => {
  mockFetch([
    [host(OA), () => new Response("", { status: 404 })],
    [(u) => u.host === S2, () => json({ paperId: "s2x", title: "A paper", year: 2020, abstract: "Abs.", externalIds: { DOI: "10.1000/q" } })],
    [host("api.crossref.org"), () => json({ message: { DOI: "10.1000/q", title: ["A paper"], "container-title": ["J"] } })],
    [host("www.ebi.ac.uk"), () => json({ resultList: { result: [] } })],
  ]);
  // without a relay Semantic Scholar is skipped in the browser
  const p = await aggregator.lookup("doi", "10.1000/q");
  assert.equal(p.venue, "J");
  assert.deepEqual(new Set(p.sources), new Set(["crossref"]));
});

test("services that refuse web pages are ready only with a relay", async () => {
  const S = await import("../engine/sources/index.js");
  const { resetSettingsForTests } = await import("../engine/settings.js");
  resetSettingsForTests();
  assert.equal(S.semanticscholar.ready()[0], false);
  assert.match(S.semanticscholar.ready()[1], /relay/);
  assert.equal(S.openalex.ready()[0], true);
  resetSettingsForTests({ relay: { url: "https://relay.example.workers.dev/" } });
  assert.equal(S.semanticscholar.ready()[0], true);
  assert.equal(S.arxiv.ready()[0], true);
  const calls = mockFetch([[host("relay.example.workers.dev"), () => json({ paperId: "s2x", title: "A paper", year: 2020, externalIds: { DOI: "10.1000/q" } })]]);
  const p = await S.semanticscholar.paper("doi", "10.1000/q");
  assert.equal(p.ids.s2, "s2x");
  assert.equal(new URL(calls[0].url.searchParams.get("url")).host, "api.semanticscholar.org");
});
