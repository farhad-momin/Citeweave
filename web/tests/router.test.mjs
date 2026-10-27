// The browser back end end to end: library, sync between two devices, history, tables,
// answers without AI, GitHub sync and settings masking.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resetLibraryForTests } from "../engine/library.js";
import { _resetForTests, handle } from "../engine/router.js";
import { fresh, host, json, mockFetch, work } from "./helpers.mjs";

function reset(settings = {}) {
  fresh(settings);
  resetLibraryForTests();
  _resetForTests();
}

const api = {
  get: (u) => handle("GET", u),
  post: (u, b = {}) => handle("POST", u, b),
  put: (u, b = {}) => handle("PUT", u, b),
  patch: (u, b = {}) => handle("PATCH", u, b),
  del: (u) => handle("DELETE", u),
};

async function waitJob(id) {
  for (let i = 0; i < 200; i++) {
    const j = await api.get(`/api/jobs/${id}`);
    if (j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job timed out");
}

const paper = (n) => ({ id: `doi:10.1234/p${n}`, doi: `10.1234/p${n}`, title: `Paper number ${n} on concrete`, year: 2020 + n,
  authors: [{ name: "Rahim Uddin" }], abstract: `Abstract ${n}.`, ids: {}, source: "import" });

test("status says web and lists sources", async () => {
  reset();
  const s = await api.get("/api/status");
  assert.equal(s.platform, "web");
  assert.ok(s.sources.find((x) => x.name === "openalex"));
  assert.equal(s.ai.enabled, false);
});

test("settings hide secrets and keep them when masked values come back", async () => {
  reset();
  await api.put("/api/settings", { ai: { keys: { openai: "sk-secret-1234" } }, sync: { github: { token: "github_pat_abcd9876" } } });
  const pub = await api.get("/api/settings");
  assert.equal(pub.ai.keys.openai, "••••1234");
  assert.equal(pub.sync.github.token, "••••9876");
  await api.put("/api/settings", pub);
  const { settings } = await import("../engine/settings.js");
  assert.equal(settings().get("ai", "keys", "openai"), "sk-secret-1234");
});

test("library: collections, papers, status, notes, tags", async () => {
  reset();
  const cols = await api.get("/api/collections");
  assert.equal(cols.length, 1);
  const c = await api.post("/api/collections", { name: "RCA review" });
  assert.equal(typeof c.id, "string");
  const added = await api.post(`/api/collections/${c.id}/papers`, { papers: [paper(1), paper(2)] });
  assert.equal(added.added, 2);
  assert.equal((await api.post(`/api/collections/${c.id}/papers`, { papers: [paper(1)] })).added, 0);
  await api.post(`/api/collections/${c.id}/status`, { paper_id: paper(1).id, status: "read" });
  await api.put("/api/notes", { paper_id: paper(1).id, body: "Good method" });
  await api.put("/api/tags", { paper_id: paper(1).id, tags: ["method", "method", " review "] });
  const list = await api.get(`/api/collections/${c.id}/papers`);
  const p1 = list.find((p) => p.id === paper(1).id);
  assert.equal(p1.status, "read");
  assert.equal(p1.note, "Good method");
  assert.deepEqual(p1.tags, ["method", "review"]);
  await assert.rejects(api.post(`/api/collections/${c.id}/status`, { paper_id: paper(1).id, status: "bogus" }), /status must be/);
  await api.post(`/api/collections/${c.id}/remove`, { paper_id: paper(2).id });
  assert.equal((await api.get(`/api/collections/${c.id}/papers`)).length, 1);
  await api.patch(`/api/collections/${c.id}`, { name: "RCA" });
  assert.ok((await api.get("/api/collections")).find((x) => x.name === "RCA" && x.count === 1));
});

test("sync: two devices exchange changes, deletions and newer edits", async () => {
  // device A
  reset();
  const c = await api.post("/api/collections", { name: "Shared" });
  await api.post(`/api/collections/${c.id}/papers`, { papers: [paper(1), paper(2)] });
  await api.put("/api/notes", { paper_id: paper(1).id, body: "from A" });
  await api.post("/api/history", { question: "Q from A?", answer: "A [1]", papers: [paper(1)], mode: "extractive" });
  const docA = await api.get("/api/sync/export");
  assert.equal(docA.format, "citeweave-sync");
  assert.ok(docA.papers[paper(1).id]);

  // device B starts empty, imports A, then changes things
  reset();
  const r = await api.post("/api/sync/import", docA);
  assert.ok(r.applied >= 5);
  const colsB = await api.get("/api/collections");
  const shared = colsB.find((x) => x.name === "Shared");
  assert.equal(shared.count, 2);
  assert.equal((await api.get("/api/history"))[0].question, "Q from A?");
  await new Promise((r2) => setTimeout(r2, 5));
  await api.post(`/api/collections/${shared.id}/remove`, { paper_id: paper(2).id });
  await api.put("/api/notes", { paper_id: paper(1).id, body: "edited on B" });
  const docB = await api.get("/api/sync/export");

  // back on A (fresh store holding A's data), import B
  reset();
  await api.post("/api/sync/import", docA);
  await api.post("/api/sync/import", docB);
  const listA = await api.get(`/api/collections/${shared.id}/papers`);
  assert.deepEqual(listA.map((p) => p.id), [paper(1).id]);
  assert.equal(listA[0].note, "edited on B");
  // importing the older document again changes nothing
  const again = await api.post("/api/sync/import", docA);
  assert.equal(again.applied, 0);
  await assert.rejects(api.post("/api/sync/import", { format: "citeweave-sync-encrypted" }), /locked/);
});

test("tables saved from a chatbot reply can be listed and downloaded", async () => {
  reset();
  const rows = [{ paper_id: paper(1).id, based_on: "abstract", values: { Method: { value: "Lab tests", quote: "" } }, error: null,
    paper: { id: paper(1).id, title: paper(1).title, year: 2021 } }];
  const t = await api.post("/api/tables", { name: "Chatbot table", columns: [{ name: "Method" }], rows });
  const tables = await api.get("/api/tables");
  assert.equal(tables[0].id, t.id);
  const csv = await api.get(`/api/tables/${t.id}/csv`);
  assert.match(csv, /Lab tests/);
  await api.del(`/api/tables/${t.id}`);
  assert.equal((await api.get("/api/tables")).length, 0);
});

test("ask without AI ranks papers and builds an answer from key sentences", async () => {
  reset({ sources: { semanticscholar: { enabled: false }, crossref: { enabled: false }, europepmc: { enabled: false }, arxiv: { enabled: false }, pubmed: { enabled: false } } });
  mockFetch([[host("api.openalex.org"), () => json({ meta: { count: 2 }, results: [
    work("W1", "Recycled aggregate and strength", 2018, { abstract: "Recycled coarse aggregate reduced compressive strength by 12 percent." }),
    work("W2", "Bridge decks", 2019, { abstract: "Bridge decks were inspected in winter." }),
  ] })]]);
  const { job } = await api.post("/api/ask", { question: "Does recycled coarse aggregate reduce compressive strength?" });
  const j = await waitJob(job);
  assert.equal(j.status, "done", j.error);
  assert.equal(j.result.answer_kind, "extractive");
  assert.equal(j.result.papers[0].title, "Recycled aggregate and strength");
  assert.match(j.result.answer, /12 percent.*\[1\]/);
});

test("extract without AI saves a free evidence table and exports its provenance", async () => {
  reset();
  const p = { ...paper(1), abstract: "We tested concrete using compression tests." };
  const started = await api.post("/api/extract", { columns: [{ name: "Method" }], papers: [p] });
  const job = await waitJob(started.job);
  assert.equal(job.status, "done");
  assert.equal(job.result.rows[0].mode, "extractive");
  assert.equal(job.result.rows[0].values.Method.quote, p.abstract);
  const csv = await api.get(`/api/tables/${job.result.id}/csv`);
  assert.match(csv, /Method \(quote\)/);
  assert.match(csv, /source excerpt/);
});

test("GitHub sync reads and writes through the contents API with the stored token", async () => {
  reset({ sync: { github: { token: "tok123", repo: "me/data", branch: "main", path: "citeweave-sync.json" } } });
  const stored = { content: null, sha: null };
  const calls = mockFetch([[host("api.github.com"), (url, init) => {
    assert.equal(init.headers.Authorization, "Bearer tok123");
    if ((init.method || "GET") === "GET") {
      if (url.pathname === "/repos/me/data") return json({ full_name: "me/data" });
      if (!stored.content) return new Response("{}", { status: 404 });
      return json({ sha: stored.sha, content: stored.content });
    }
    const body = JSON.parse(init.body);
    stored.content = body.content; stored.sha = "sha2";
    return json({ content: { sha: "sha2" } });
  }]]);
  assert.deepEqual(await api.post("/api/sync/github", { action: "read" }), { document: null, sha: null });
  const doc = await api.get("/api/sync/export");
  await api.post("/api/sync/github", { action: "write", document: doc });
  const back = await api.post("/api/sync/github", { action: "read" });
  assert.equal(back.document.format, "citeweave-sync");
  assert.equal(back.sha, "sha2");
  assert.ok(calls.length >= 3);
});

test("unknown routes and Zotero explain themselves", async () => {
  reset();
  await assert.rejects(api.get("/api/nothing-here"), /Not available in the web version/);
  await assert.rejects(api.post("/api/zotero/send", {}), /PC app/);
});
